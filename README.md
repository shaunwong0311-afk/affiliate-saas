# Vantage — Affiliate Recruitment Platform

A merchant-focused affiliate program platform where **tracking is table stakes and
recruitment is the wedge**. Built on a shared substrate with a **pluggable commission
engine**, so the affiliate engine ships first and an MLM/direct-selling engine stays a clean
future option on the same chassis.

It is a TypeScript monorepo: a pure domain core, a multi-tenant API, an edge tracking hot
path, a recruitment engine that finds, scores and emails prospective affiliates, and a React
dashboard plus affiliate portal. It follows the
[build plan](./affiliate-platform-build-plan%20%281%29.md); the plan's breadth (CRM
integrations, report builder, subscription-billing connectors and similar) is not all built.

> **It runs with zero external services.** The default store is in-memory and every external
> integration sits behind an adapter with a deterministic stub. `npm run demo` exercises the
> money path and the recruitment loop in one process, on clearly labelled demo data.

> **Status: a working prototype, not yet validated against real providers.** Everything is
> tested offline and against local services (Postgres, a mail catcher, Docker). No third-party
> key has ever run. See "What is proven" below and `CLAUDE.md`.

---

## Quick start

```bash
npm ci
npm test                 # 1,303 offline tests
npm run typecheck        # backend graph + web app
npm run demo             # seed → commission → override → clawback → payouts → recruitment

# run the stack (3 terminals)
SEED_DEMO=true npm run api   # API            → http://localhost:8787  (prints the demo login)
npm run edge                 # tracking edge  → http://localhost:8788/c/:code
npm run web:dev              # dashboard+portal → http://localhost:5173
```

Sign in at the web app with **owner@demo.test / demo1234**. (PowerShell:
`$env:SEED_DEMO="true"; npm run api`.)

Configuration is by environment variable; `.env.example` lists every one. Nothing loads a
`.env` file automatically — use `node --env-file=.env …` or export the variables.

---

## Architecture

```
packages/
  core/           Pure domain — no I/O. Commission-engine seam + affiliate engine + MLM stub,
                  ledger and balances, attribution, fraud, money math, signing and secret
                  rules, prospect scoring, affiliate-link detection, identity graph.
  db/             Repository ports + an in-memory adapter (default) + a Postgres adapter
                  (one JSONB document table per collection). Both enforce the same
                  uniqueness rules; transactions are connection-bound and roll back;
                  `withLock` serializes across processes.
  integrations/   Adapters behind interfaces, each with a stub: order ingestion
                  (Shopify/Woo/Stripe/S2S), discovery, enrichment, mailbox senders and
                  reply ingestion, transactional email, LLM clients, payout rails, the
                  SSRF-safe fetcher.
  tracking-edge/  Redirect hot path (resolve link → mint click_id → cookie → 302 → async
                  click write). The same handler runs as a Node service; the Cloudflare
                  Workers entry exists but its KV sync and queue consumer are not built.
  recruitment/    The wedge: scheduler, six stages (source → enrich → score → outreach →
                  reply → learn), multi-touch sequencing, reply router, deliverability
                  monitoring, closed-loop learning. See RECRUITMENT.md.
  api/            Fastify: JWT + API-key auth, tenant-scoped RBAC, the write path
                  (ingest → attribution → fraud → engine → ledger), payout orchestration,
                  about 190 routes.
  web/            React + Vite SPA — merchant dashboard + affiliate portal.
deploy/           Dockerfile, docker-compose, wrangler.toml. See DEPLOYMENT.md.
```

### The commission-engine seam

Commission calculation lives behind a narrow interface (`packages/core/src/engine/types.ts`).
The substrate assembles a context (all reads), calls the engine (pure compute), and writes
the returned money events to the ledger (all writes):

```ts
interface CommissionEngine {
  onOrder(ctx)    -> CommissionEvent[]   // event-driven (affiliate)
  runCycle(ctx)   -> CommissionEvent[]   // batch (MLM commission runs)
  onReversal(ctx) -> ReversalEvent[]     // clawback cascade
  qualify(ctx)    -> Qualification       // tiers / ranks
}
```

The **affiliate engine** applies a rate, walks the sponsor pointer up one level for a
two-tier override, and emits events. The **MLM engine is a deliberate stub** — it proves the
seam and documents the future vertical; MLM offers are rejected at creation.

### Money never passes through the platform

Vantage computes who is owed what and keeps the books. It does not hold funds, and there are
no platform-wide payout credentials. Approving a payout batch moves its payouts to
**awaiting payment**; the merchant downloads a payout file (PayPal mass-pay, Wise batch or a
generic CSV), pays from their own account, and marks each payout paid or failed. A connected
payout rail, where one is added, runs only on that merchant's own credentials.

### What is real and what is a stub

| Real and tested | Adapter exists, not validated against the live service | Stub / not built |
|---|---|---|
| Commission math, tiers, bonuses, two-tier overrides, basis rules | SMTP sending (`nodemailer`) and IMAP reply reading (`imapflow`) | Automated payout rails (Stripe / PayPal / Wise classes are unwired) |
| Ledger, reversals and clawbacks, reserved-entry payouts | Microsoft Graph and Gmail sending; Graph inbox polling; OAuth | Calendar booking (a merchant-pasted link ships) |
| Idempotent conversion ingest (unique constraint), signed postbacks | Resend / Postmark transactional mail | Workers KV sync and queue consumer |
| Attribution, fraud heuristics, status enforcement | DataForSEO, SerpApi, YouTube, iTunes, Hunter, scrape-actor adapters | Complaint (FBL) feed |
| Postgres adapter: transactions, locks, uniqueness (tested on Postgres 16) | Anthropic and OpenAI-compatible LLM clients | Partial refunds |
| Manual payout flow: export file, mark paid / failed | Proxy fetching (`undici`), headless fetching (Playwright) | Gmail-via-Google reply reading |
| Tenant RBAC, single-use sign-in and invitation links, signed unsubscribe | | MLM engine |
| Prospect scoring, identity graph, discovery planning (on demo data) | | |

---

## How the money path works (one order, end to end)

1. **Click** → the edge mints a UUIDv7 `click_id`, sets a first-party cookie, 302s, and writes
   the click asynchronously.
2. **Conversion** → the merchant's server sends an HMAC-signed postback. The body is
   schema-validated and the signature and timestamp verified before anything is written.
   Shopify / Woo / Stripe payloads are normalized through an authenticated ingest route.
3. **Idempotency** → an order is unique per `(merchant, transaction id)` at the database, so a
   retried or duplicated delivery is answered `duplicate`.
4. **Attribution** → `click_id`, else last click by the same customer within the window, else
   the coupon code; a per-program priority breaks ties. Links and codes of a banned affiliate
   or a paused offer do not earn.
5. **Fraud** → IP velocity, click-to-conversion timing, reversal rate and sponsorship checks
   give approve / review / reject.
6. **Engine** → the offer's engine computes the seller's commission and, if the seller was
   sponsored, the recruiter's override.
7. **Ledger** → entries are written as `pending` / `approved` with an `available_at` from the
   program's hold period. A refund reverses them; after payout it writes a clawback.
8. **Payout** → balances are derived from the ledger, gated on a tax form, a payout account
   and a minimum. A batch reserves the exact entries it pays; the merchant pays from their own
   account and records it.

Run `npm run demo` to watch this against seeded data.

---

## What is proven

Offline: 1,303 tests, both typechecks, the web build.

Against local services (reproducible; see `CLAUDE.md`):
- **Postgres 16** — one order delivered five times at once records one commission; two
  simultaneous payout batches pay once; overlapping transactions leave nothing partial.
- **Docker Compose** — the stack builds, all four containers are healthy, and a link created
  through the API redirects through the edge and is recorded.
- **SMTP** — real delivery through `nodemailer` into a local mail catcher, unsubscribe headers
  and threading intact.
- **Browser** — every dashboard and portal page, the affiliate sign-in link, team invitations,
  unsubscribe, manual payouts and bulk import.

Not proven: anything that needs a third-party account. See the caveat in `CLAUDE.md`.

## Testing

```bash
npm test                                   # offline
TEST_DATABASE_URL=postgres://… npm test    # also runs the Postgres-backed suites
npm run typecheck
```

The in-memory store serializes requests, so concurrency bugs only show on Postgres. Changes
to the money or send path should be run with `TEST_DATABASE_URL` set; CI always does.

## Deployment

Cloudflare edge (Pages SPA + Workers redirect) over an origin running the API, worker, Node
edge and Postgres. See [DEPLOYMENT.md](./DEPLOYMENT.md), including the operational rules:
never send mail from the box IP, scrape through proxies, back the database up off-box.

## Non-goals

Not the merchant of record · not a holder of funds · not building MLM now (the seam keeps it
a future option) · not an affiliate-side marketplace now.

_Not legal or tax advice. Confirm outreach-compliance, payout and tax rules before scaling._
