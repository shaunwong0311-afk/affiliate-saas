# CLAUDE.md — affiliate-saas project guide

Read this first each session. It is the durable map: what the project is, how it is built,
how to run it, the rules that must not be broken, and what is and is not proven to work.
Deeper detail: `README.md`, `RECRUITMENT.md`, `DEPLOYMENT.md`, `REMEDIATION.md`,
`docs/OUTREACH-SPEC.md`, `docs/PROFILE-GRAPH.md`, the audits (`docs/AUDIT-2026-07.md`,
`docs/AUDIT-2026-10.md`) and the original `affiliate-platform-build-plan (1).md`.

## What this is

"Vantage" — a recruitment-wedge **affiliate SaaS platform**. Thesis: tracking and payouts are
table stakes; **recruitment is the wedge** — autonomously *finding quality affiliates* for
merchants. Built on a shared substrate with a **pluggable commission engine** (affiliate
engine first; MLM a deliberate stub proving the seam).

It runs with **zero external services** by default (in-memory store; every external
integration sits behind an adapter with a deterministic stub). Real providers switch on by
setting env keys. Without keys the system runs on labelled **demo data**.

## Rules that must not be broken

1. **Honesty discipline.** Produce evidence-backed real data OR label it demo — never
   fabricate. Every prospect carries `synthetic`; provider-backed signals are `null` when
   unknown (excluded from scoring, reported as confidence + `unknownFactors`). A real prospect
   never gets a guessed email address. A demo prospect is never emailed through a real mailbox.
2. **Never record success that did not happen.** A send that failed is `failed`, a payout
   that did not move money is not `paid`. In production nothing falls back to a mock.
3. **No custody.** Money never passes through the platform. We compute who is owed what; the
   merchant pays from their own account (payout file + mark-as-paid). There are no
   platform-wide payout credentials, and a connected rail may only ever run on the merchant's
   own credentials. Do not add a pooled balance, a float, or a platform-level rail key.
4. **The in-memory store hides concurrency bugs.** It never yields to the event loop, so
   requests are effectively serialized and a race cannot show up in the offline suite. Any
   change to the money path, payout lifecycle, send path or anything that uses
   `db.transaction` / `db.withLock` must be run against Postgres (`TEST_DATABASE_URL`, below).
   This is how double payouts shipped "green" before October 2026.
5. **Fail closed.** Missing or weak secrets stop a production boot; an unconfigured webhook
   secret refuses the route; a proxy that cannot be used fails the fetch instead of going
   direct; outbound fetches of page- or tenant-supplied URLs go through `net-guard.ts`.
6. **Tenant isolation.** Every entity-by-id handler checks `merchantId`. An affiliate is a
   GLOBAL identity shared across merchants: anything a merchant records about one (payout
   account, tax form) is scoped to that merchant; nothing a tenant does may affect another
   tenant (no tenant-created global suppressions).

## Monorepo layout (npm workspaces, TypeScript, ESM with `.js` import specifiers)

| Package | Role |
|---|---|
| `packages/core` | Pure domain, no I/O: commission-engine seam + affiliate engine, ledger and balances, attribution, fraud, money math, postback / unsubscribe signing and secret rules (`security/`), scoring, triage, affiliate-link detection, identity graph + merge (`profile/`), network registry, host classification (`profile/hosts.ts`), AI-SDR, content gate, activation email builder. |
| `packages/db` | Repository ports + two adapters. `memory.ts` (default) and `postgres.ts` (one JSONB document table per collection, DDL generated from the collection list). Shared `constraints.ts` declares uniqueness enforced by BOTH adapters. `db.transaction(fn)` is bound to one connection and rolls back on throw; `db.withLock(key, fn)` serializes across processes. `schema.sql` is a reference model that nothing applies. |
| `packages/integrations` | Every external adapter + its stub: discovery (SERP / backlinks / YouTube / podcast / social), enrichers, email find/verify, mailbox senders (SMTP, Graph, Gmail), reply ingestion (IMAP, Graph, delivery-status parsing), ESP, OAuth, LLM clients, payout rails, secrets store, `http.ts` fetchers, `net-guard.ts` (SSRF-safe fetch). |
| `packages/recruitment` | The recruitment engine: discover → enrich → score → queue → send → reply → learn; planner, frontier, contact resolver, sequencing, reply router, deliverability, per-merchant send lock (`merchant-lock.ts`), automation cycle, scheduler. Depends on a structural subset of the API's `AppContext` (`deps.ts`). |
| `packages/tracking-edge` | Click redirect: a Cloudflare-Workers-style handler that also runs as a Node server. |
| `packages/api` | Fastify. JWT + API-key auth, tenant RBAC, the conversion → ledger → payout write path, about 190 routes, `context.ts` (the DI container wiring every adapter by env), `config.ts` (env parsing + production guards), `worker.ts` (standalone scheduler, same context as the API). |
| `packages/web` | React + Vite SPA: merchant dashboard + affiliate portal. Hash router (`router.tsx`, routes in `App.tsx`), pages in `src/pages/`, portal in `src/portal/`, shared UI in `src/ui.tsx`, API client in `src/api.ts`. Dark "operator console" look, lime accent; theme variables in `src/styles.css`. No test runner. |

## Run it

```bash
npm ci
npm test                      # vitest, offline — 1,303 tests
npm run typecheck             # tsc -b for the backend graph, then the web app's tsc --noEmit
npm run build -w @affiliate/web
npm run demo                  # end-to-end console narrative, no servers
SEED_DEMO=true npm run api    # API :8787, seeds a demo tenant (idempotent), prints the login
npm run edge                  # tracking edge :8788
npm run worker                # standalone scheduler (needs the same DATABASE_URL as the API)
npm run web:dev               # dashboard :5173 (Vite proxies /api → :8787)
```

- Seeded demo login: `owner@demo.test` / `demo1234` (merchant "Lumen Skincare", competitors
  `glowrival.com`, `dewdrop.com`). PowerShell: `$env:SEED_DEMO="true"; npm run api`.
- **Postgres-backed tests** (transactions, locks, uniqueness, concurrent money paths) are
  skipped unless `TEST_DATABASE_URL` points at a throwaway database:
  ```bash
  docker run -d --rm --name vantage-test-pg -e POSTGRES_USER=vantage -e POSTGRES_PASSWORD=vantage \
    -e POSTGRES_DB=vantage -p 127.0.0.1:5433:5432 --tmpfs /var/lib/postgresql/data postgres:16
  TEST_DATABASE_URL=postgres://vantage:vantage@127.0.0.1:5433/vantage npm test
  ```
  CI (`.github/workflows/ci.yml`) always runs them.
- Nothing loads `.env` automatically: `node --env-file=.env --import tsx <entrypoint>`, or
  export the variables. `.env.example` lists every variable the code reads.
- Full stack in containers: `docker compose --env-file .env -f deploy/docker-compose.yml up --build`
  (see `DEPLOYMENT.md`). On a shared server behind its own reverse proxy, add
  `-f deploy/single-host/compose.override.yml` (isolated, resource-limited, read-only).
- Public signup is closed in production (`ALLOW_SIGNUP`); create the first merchant with
  `npm run create-owner -- --merchant "Name" --email owner@example.com --currency MYR`,
  which prints a single-use owner invite link.
- Tests, typecheck and the web build must stay green before committing. Commit/push only when
  asked; author is `shaunwong0311`; remote `shaunwong0311-afk/affiliate-saas`; commits
  co-authored by Claude.

## Environment variables

`.env.example` is the complete, commented list — keep it in step with `config.ts` and
`context.ts`. The keys that turn demo mode into real work:

| Env | Enables |
|---|---|
| `DATABASE_URL` | Postgres for API, worker and edge (they must share it). Unset = private in-memory store per process. |
| `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` | Real competitor backlink mining, the recursive frontier, and real Google SERP. |
| `SERPAPI_KEY` | Real SERP through SerpApi instead. |
| `YOUTUBE_API_KEY` | YouTube channel discovery + reach/engagement (free API). |
| `SCRAPE_API_URL` (+ `SCRAPE_API_KEY`) | Instagram / TikTok / X counts and creator discovery. Contract unverified against any vendor. |
| `HUNTER_API_KEY` | Email finding / mailbox-level verification. Without it, no published address = no contact. |
| `PROXY_URL` | Scraping through a proxy pool; when set, a fetch that cannot use it fails. |
| `BROWSER_FETCH` | Headless-browser fallback for blocked pages (needs `playwright` installed). |
| `ANTHROPIC_API_KEY` | Real LLM: AI-SDR, classification, personalization (`claude-opus-4-8`); relevance falls back to `claude-haiku-4-5`. |
| `RELEVANCE_LLM_*` | A cheap OpenAI-compatible model for relevance scoring. |
| `RESEND_API_KEY` / `POSTMARK_SERVER_TOKEN` + `TRANSACTIONAL_FROM` | Delivery of sign-in links, activation emails, team invitations. |
| `MS_OAUTH_*`, `GOOGLE_OAUTH_*` | Connecting Microsoft / Google mailboxes. |
| `INBOUND_WEBHOOK_SECRET` | The inbound-reply webhook (503 in production until set). |
| `TRUST_PROXY` | Correct client addresses behind a proxy/CDN (rate limiting). |

Production boot requires `JWT_SECRET` of at least 32 characters that is not a placeholder.
`SECRETS_ENC_KEY`, `UNSUBSCRIBE_SECRET` and `API_KEY_PEPPER` default to values derived from
it; an empty value counts as unset. Synthetic discovery is off in production unless
`ALLOW_SYNTHETIC_DISCOVERY=true`.

## The money path

Click → signed postback (schema-validated, HMAC, replay window) → attribution → fraud →
commission engine → ledger → payout. Facts worth knowing before touching it:

- **Idempotency is a database constraint**, not a check: orders are unique on
  `(merchantId, txnId)` in both adapters; a duplicate delivery is answered `duplicate`.
- **Payout batches** are created, approved, retried, cancelled and marked under a per-merchant
  lock plus a transaction. A batch reserves the exact ledger entries that make up each payout
  (negatives included) and the payout amount is the sum of what it reserved.
- **Payouts are manual by default** (rule 3). Approving a batch moves payouts to
  `awaiting_payment`; the merchant downloads a payout file
  (`GET /payouts/batches/:id/export?format=paypal|wise|csv`), pays from their own account and
  records it with `POST /payouts/:id/mark-paid` or `mark-failed`. The `mock` rail exists only
  outside production. The Stripe / PayPal / Wise classes are unwired adapters that accept one
  merchant's own credentials.
- A refund that lands while money is reserved reduces or cancels the pending payout; a
  refund after payment writes a clawback.
- Offer and commission-term changes are validated on create AND update. Link attribution and
  the edge refuse relationships, affiliates and offers that cannot earn.
- Payout accounts and tax forms a merchant records for an affiliate count for that merchant only.
- Known limits: no partial refunds; no asynchronous rail settlement; currencies that are not
  two-decimal (JPY) are mis-scaled; the Postgres adapter still filters in JS (`find` reads the
  whole table) — fine for now, the first thing to fix for scale.

## The recruitment engine

Six stages: **source → enrich → score → outreach → reply → closed loop**, operated as "L4
with two human gates" (A-tier outreach approval, warm-reply handoff). Detail in `RECRUITMENT.md`.

**Discovery and enrichment**
- Sources behind `DiscoverySource`: SERP (SerpApi or DataForSEO), competitor backlink mining,
  YouTube, podcasts (iTunes + RSS), social creator discovery, synthetic generators (demo
  only). `planDiscovery` orders them warmest-first and skips what cannot run.
- Sourcing runs on its own interval (`AutomationState.sourcingIntervalHours`, default 24),
  not on every scheduler tick; sends, follow-ups and reply ingestion run every tick.
- Ingest excludes the competitor's own domains, the merchant's own domains, marketplaces and
  social hosts (`core/profile/hosts.ts`, `recruitment/guards.ts`).
- Contact emails are accepted only from a page the creator demonstrably owns (their site, or
  an account with seed / bio-aggregator / reciprocal provenance) — never from a page merely
  linked to, never an address at a competitor's or the merchant's domain.
- Identity merge uses owned handles and own-domain emails only; platform URLs without a
  handle are not identities.
- Scoring (`core/recruitment/scoring.ts`): weights relevance 0.20, affiliate propensity 0.30,
  reach 0.10, quality 0.15, commercial intent 0.10, contactability 0.10, audience overlap
  0.05, activity 0.05. Unknown factors are dropped and the rest renormalized. Engagement is
  mapped on a scale (1% → 0.5, 3% → 0.85, ≥5% → 1), not used raw.
- A source is pruned only on mature evidence: at least 20 prospects contacted 30+ days ago
  with under 2% producing, and never the last usable source (`recruitment/learning.ts`).
- The frontier promotes a co-promoted merchant only when the network registry identifies it
  or a HIGH-confidence signal points at it.
- Adapters surface provider errors (`SourcingSummary.sourceErrors`) instead of reporting
  "no results".

**Outreach**
- Send-as-the-merchant: `SmtpSender` (the launch rail), `MicrosoftGraphSender`, `GmailSender`.
  Every message carries our own `Message-Id`, which is what is stored and threaded on.
- Every path that queues or sends runs inside `withMerchantLock`; a prospect cannot be
  queued twice or a message sent twice by overlapping runs.
- Only recipient-level permanent failures are bounces. Sender-side, policy, quota and auth
  rejections are `failed`, do not suppress anyone, and back the mailbox off.
- Replies: IMAP poll for SMTP mailboxes, Graph poll for Microsoft mailboxes. A mailbox whose
  replies cannot be read (Gmail-via-Google today, SMTP without IMAP) sends first touches only:
  **follow-ups stay on hold** until the inbox can be read. Replies are matched by
  `In-Reply-To` / `References` before the From address. Delivery-status notifications mark
  the prospect bounced.
- Suppression: a signed unsubscribe link (works for form posts and RFC 8058 one-click) or a
  STOP reply to mail we really sent creates a platform-wide row; everything a tenant enters is
  merchant-scoped.
- Sending is blocked when the merchant has no postal address on file. The campaign time zone
  and the recipient's local time are honoured. A content-gate block lifts when the copy changes.
- AI-SDR: topic gate + grounded knowledge-base answers. Autopilot sends deterministic
  knowledge-base answers through the reply transport and hands everything else to a human.
- DMs are never automated: a `dm` step creates a prepared task for the operator.
- There is no complaint feed; complaint figures read "not available", never zero.

## Web app notes

- Public routes rendered outside the authenticated shell: `/join/:merchantId`,
  `/portal/verify?token=…` (affiliate sign-in link), `/accept-invite?token=…` (team invitation).
  Both tokens are single-use — post them exactly once.
- Declare as optional any field the API can omit; an error boundary wraps the routed page.
- The API strips `postbackSecret` and `passwordHash` from reads; secrets come from their own
  admin-gated endpoints.

## Live deployment (Perfect Design)

Running since 2026-10-17 at **https://partners.perfectdesign.my**, for one business (Perfect
Design), on the Perfect Design server (Hetzner `46.225.78.249`, SSH key
`~/.ssh/hetzner_perfectdesign`, user root). That server also runs Perfect Design's own API
(PM2), its CRM/communications Postgres, Redis and a WhatsApp bridge — treat it as live
customer infrastructure: say what you will change before changing it, and leave a line in the
Website-prototype-automation repo's `.devbox/notes.md` (`devbox-note`).

- Layout: `/opt/vantage/` — `.env` (root, 600; secrets generated on the server, never
  printed), `deploy/` (base compose + `single-host/` override, Caddy block, backup script),
  `web/` (built SPA served by Caddy).
- Run: `cd /opt/vantage && docker compose -p vantage --env-file /opt/vantage/.env -f
  deploy/docker-compose.yml -f deploy/single-host/compose.override.yml up -d` (postgres, api,
  worker; the edge is off). Containers are `vantage-{postgres,api,worker}-1`.
- Release: build the image on the dev box (`docker build -f deploy/Dockerfile -t
  vantage:<date>-<sha> .`), ship it (`docker save | gzip | ssh … "gunzip | docker load"`),
  set `VANTAGE_IMAGE_TAG` in `/opt/vantage/.env`, `up -d`. Rebuild the SPA and copy it to
  `/opt/vantage/web/`. Never build on the server.
- Isolation: ufw rule 1 `deny in on br-vantage` — Vantage containers cannot reach any host
  service (verified: SSH, Caddy, the other API, Postgres, Redis, WhatsApp bridge all
  blocked; internet egress works). Postgres has no host port; the API listens on
  `127.0.0.1:18787` for Caddy only. 512 MB / 1 CPU per container.
- Caddy: the `partners.perfectdesign.my` block in `/etc/caddy/Caddyfile` (backup taken
  before the change as `Caddyfile.bak-20261017-*-before-vantage`). Always `caddy validate`
  before `systemctl reload caddy` — the same file serves `api.perfectdesign.app`.
- DNS: `partners` A record → `46.225.78.249`, not proxied (Cloudflare zone perfectdesign.my),
  so Caddy issues the certificate.
- Config: production, `ALLOW_SIGNUP=false`, `PUBLIC_API_URL=https://partners.perfectdesign.my/api`,
  `TRUST_PROXY=172.31.250.1` (Docker's port proxy).
- Backups: `/etc/cron.d/vantage-backup` at 02:45 → `/opt/backups/vantage` (14 days). On the
  server only, like the host's other dumps — no off-server copy yet.
- Health check (read-only, run after any change on that server, by either project):
  `ssh -i ~/.ssh/hetzner_perfectdesign root@46.225.78.249 /opt/vantage/deploy/single-host/check.sh`
  — Perfect Design's API, icaur.com.sg, PM2, WhatsApp bridge, Caddy, memory/disk; Vantage's
  containers, URLs, closed signup, certificate; the isolation rule and a live probe from inside
  Vantage; backup freshness. Exit 0 = all PASS (WARNs allowed).
- Not yet configured: the Perfect Design merchant and owner (`create-owner`), a transactional
  email key, the outreach mailbox.

## Current state (2026-10-12)

**1,303 offline tests** plus the Postgres-backed suites, backend and web typechecks, web build
and the demo all pass. Four reviews have been remediated; the fourth (`docs/AUDIT-2026-10.md`)
is the first that ran the system rather than read it.

Proven by running it (local services, no third-party accounts):
- Postgres 16: one order delivered five times at once records one commission; two
  simultaneous payout batches pay each affiliate once; twenty overlapping transactions leave
  no partial or lost writes; data survives a restart.
- The Docker Compose stack builds and boots — API, worker, edge and Postgres healthy — and a
  tracking link created through the API redirects through the edge and is recorded.
- Real SMTP delivery through `SmtpSender` and `nodemailer` into a local mail catcher, with
  unsubscribe headers and reply threading intact.
- The proxy fetcher with the real `undici` package: goes through a working proxy, fails on a
  dead one, refuses internal addresses.
- A headless-browser pass over all 20 dashboard pages and 6 portal pages, the affiliate
  sign-in link, team invitation, unsubscribe page, manual payout flow and bulk import.

> ### Still not validated — do not overclaim
> **No third-party provider key has ever run.** Untested against the real service:
> DataForSEO, SerpApi, YouTube, Hunter, the scrape actor, iTunes; a real mailbox provider's
> SMTP and IMAP (only a local catcher); Microsoft Graph and Gmail sends and Graph inbox
> polling; OAuth consent and token refresh; Resend and Postmark; the Anthropic and
> OpenAI-compatible clients; Playwright fetching; the PayPal and Wise payout-file layouts
> (written from memory of their formats, never uploaded); Cloudflare Workers deployment.
> `docs/AUDIT-2026-10.md` (D16) lists the provider assumptions most likely to be wrong.
> Until a keyed pass is done, do not describe the system as safe to point at real prospects.

## Next steps

**Tier 0 — keyed validation (needs accounts, not more code).**
1. Deploy with real secrets per `DEPLOYMENT.md`; set `TRUST_PROXY`, an ESP key and
   `TRANSACTIONAL_FROM`; back the database up off-box.
2. Connect ONE real mailbox (SMTP + IMAP): send to a test address, reply, confirm the reply
   stops the sequence; confirm a bounce is recorded from the delivery-status notification.
3. One Microsoft OAuth round trip: consent, send, inbox poll, token refresh.
4. Confirm a sign-in link, an activation email and a team invitation actually deliver.
5. A small keyed discovery run per provider; read `sourceErrors`; fix the adapter assumptions
   listed under D16.
6. Upload one generated PayPal and one Wise payout file to a sandbox.
7. Warm the mailbox before any volume; watch the Deliverability page.

**Tier 1 — known gaps (real building).**
- Per-offer redirect destination for the Node edge (today one `EDGE_DEFAULT_DEST`), and the
  Workers KV sync / queue consumer for the Cloudflare edge.
- Gmail-via-Google reply reading (until then those mailboxes hold follow-ups).
- A complaint feed (ESP/FBL), so the breaker has real complaint data.
- Partial refunds; asynchronous payout-rail settlement; non-two-decimal currencies.
- Query pushdown in the Postgres adapter.
- Email verification at merchant signup; multi-instance rate limiting (currently per process).
- A web test runner (the SPA has none) and upgrading vitest/vite to clear the remaining
  dev-tool advisories.
- Branching sequences; a tracked calendar adapter (`bookingUrl` ships; Cal.com is a skeleton).

**Tier 2 — polish.** Per-merchant ICP overrides and an explicit target market; DataForSEO Labs
niche graph for the frontier; LLM query expansion; `maxEnrich` wiring; newer Claude models
(`claude-opus-5-5`, `claude-haiku-5-5` — check `max_tokens` headroom, thinking is on by default).

## Conventions

- ESM throughout; import with `.js` specifiers even from `.ts`.
- Ports-and-adapters: define the port + a deterministic stub, gate the real adapter by env in
  `context.ts`. A stub must be unreachable in production wherever it would fake an outcome.
- New collection: the entity in `entities.ts`, the repo in `ports.ts`, then `COLLECTIONS` in
  `memory.ts` and `TABLES` in `postgres.ts` (both are typed by `CollectionName`, so the type
  checker insists on both). Declare any uniqueness in `constraints.ts`.
- Web pages are PascalCase files imported into `App.tsx`'s nav + route tables.
- Every fix gets a regression test that fails before it. Tests run offline with stubs and
  injected HTTP; money and send-path concurrency also gets a Postgres-backed test.
- Record audits in `docs/AUDIT-<date>.md` and summarize them in `REMEDIATION.md`.
