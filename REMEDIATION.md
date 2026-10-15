# Security & correctness remediation

In response to four reviews — see the sections below. The two audits with their own files are
`docs/AUDIT-2026-07.md` (outreach/discovery) and `docs/AUDIT-2026-10.md` (the whole repo, and
the first that ran the system). The suite stands at **1,303 offline tests** plus the
Postgres-backed suites; backend and web typechecks and the web build are clean.

> **Read the first three sections with the fourth in mind.** The October 2026 review found
> that several fixes below held only on the in-memory store, which serializes requests, or
> only for the exact case their test covered. Those rows are marked **[revised Oct 2026]**
> and the real fix is described under "Fourth review".
>
> **No third-party provider key has ever run.** Local services have (Postgres, a mail
> catcher, Docker); real mailbox providers, OAuth, ESPs, discovery APIs and LLMs have not.
> "Remediated" ≠ "production-validated" — see `CLAUDE.md` → Tier 0.

## Critical — fixed

| Finding | Fix | Test |
|---|---|---|
| **Payouts paid twice** **[revised Oct 2026]** | Batch creation now **reserves** the funding ledger entries (`approved`→`processing`, stamped with the payout id) inside a transaction, so a second batch sees nothing; `approveAndDisburse` is **state-guarded** (only a `draft` batch disburses, re-approve → 409). [`payout-service.ts`](packages/api/src/services/payout-service.ts) | `payout.test.ts` (+ live probe: $287.30, not $574.60) |
| **Production persistence ignored** | `createDatabaseFromEnv` wires real Postgres when `USE_POSTGRES`/`DATABASE_URL` is set; API, edge, and worker all use it. [`bootstrap.ts`](packages/db/src/bootstrap.ts), [`server.ts`](packages/api/src/server.ts) | — |
| **Affiliate login = email only** | Replaced with a **magic link** emailed to the affiliate's inbox; the magic token is single-purpose and rejected as a session. [`auth.ts`](packages/api/src/routes/auth.ts) | `remediation.test.ts` |
| **Unsigned reply webhook** | HMAC-SHA256 over the **raw body** with the merchant secret, verified before processing. [`automation.ts`](packages/api/src/routes/automation.ts), raw-body capture in [`app.ts`](packages/api/src/app.ts) | `remediation.test.ts` |
| **Secrets exposed to viewers** | `postbackSecret` redacted from merchant reads (admin-only reveal endpoint); `passwordHash` stripped from `/auth/me`. [`sanitize.ts`](packages/api/src/sanitize.ts) | `remediation.test.ts` |
| **Money writes non-transactional** **[revised Oct 2026]** | The whole order→conversion→ledger→overrides write set runs in one `db.transaction`. [`conversion-pipeline.ts`](packages/api/src/services/conversion-pipeline.ts) | — |

## High-priority — fixed

- **Cross-customer attribution** — the merchant-wide last-click fallback is gone; the fallback is now scoped to the order's own customer. [`conversion-pipeline.ts`](packages/api/src/services/conversion-pipeline.ts)
- **Multi-program / reversal engine** — conversions now store `offerId`; reversals route to that offer's engine; code attribution selects an offer in the relationship's program (not the merchant's first). [`orders.ts`](packages/core/src/types/orders.ts), [`reversal.ts`](packages/api/src/services/reversal.ts), [`attribution.ts`](packages/core/src/attribution/attribution.ts)
- **Payout rails** — each payout disburses through its own affiliate's rail; unknown/unconfigured rails **fail closed** (no silent mock). Retries use a **stable** idempotency key. [`payouts.ts`](packages/integrations/src/payouts.ts)
- **Open redirect** — `?to=` is closed by default: same-host-as-destination unless an explicit allowlist is set. [`handler.ts`](packages/tracking-edge/src/handler.ts)
- **Fraud** **[revised Oct 2026]** — IP velocity is now windowed (last hour); self-referral compares the affiliate's email hash to the customer's. [`conversion-pipeline.ts`](packages/api/src/services/conversion-pipeline.ts)
- **Validation** **[revised Oct 2026]** — affiliate creation verifies program + sponsor ownership; public apply rejects draft/archived/invite-only; offer `payoutValue` is bounded (percentage ∈ (0,1], flat = integer cents); **MLM offers are rejected** (no silent zero-commission). [`affiliates.ts`](packages/api/src/routes/affiliates.ts), [`programs.ts`](packages/api/src/routes/programs.ts)
- **Tenant scope** **[revised Oct 2026]** — global suppressions are no longer enumerable cross-tenant; GDPR delete only redacts the global affiliate when no other merchant still uses it. [`recruitment.ts`](packages/api/src/routes/recruitment.ts), [`admin.ts`](packages/api/src/routes/admin.ts)
- **SSRF** **[revised Oct 2026]** — outbound webhooks are blocked from private/loopback/link-local/metadata targets, at delivery and at creation. [`webhooks.ts`](packages/api/src/services/webhooks.ts)

## Deployment / placeholders — fixed

- Worker entrypoint builds the same context as the API and runs the scheduler. [`worker.ts`](packages/api/src/worker.ts) (the scheduler loop itself is in [`recruitment/src/worker.ts`](packages/recruitment/src/worker.ts))
- `tsx` moved to production deps (the Docker image no longer fails at startup). [`package.json`](package.json)
- DNS verification does **real** TXT lookups (SPF/DMARC) and fails closed; DKIM stays pending without a selector. [`integrations.ts`](packages/api/src/routes/integrations.ts)
- Real public **unsubscribe** endpoint; the outreach link points at it. [`ingestion.ts`](packages/api/src/routes/ingestion.ts)
- **[revised Oct 2026]** The proxy fetcher now actually routes through the proxy (undici `ProxyAgent`). [`http.ts`](packages/integrations/src/http.ts)
- SPA API base is build-time configurable (`VITE_API_BASE`). [`api.ts`](packages/web/src/api.ts)
- **[revised Oct 2026]** JWT secret must be set in production (boot fails on the dev default); basic per-IP rate limiting on auth + public webhook routes; entitlement enforcement wired on the metered sourcing route.

## Second review — data-acquisition honesty (affiliate finding)

The second review found the affiliate-finding feature "does not currently find real
affiliates — the demo's prospects are mostly synthetic," and asked that we either make
it genuinely useful **or** label it honestly. Both, now:

| Finding | Fix | Test |
|---|---|---|
| **Fabricated affiliate links on failed/short fetch** (`discovery-real.ts:86`) — created false positives even with real SERP. | The SERP source runs the **real** detector over actually-fetched HTML; a failed/short fetch records **zero** links and says "page not fetched" — never invents them. [`discovery-real.ts`](packages/integrations/src/discovery-real.ts) | `web-evidence.test.ts` (no-fabrication) |
| **Synthetic prospects indistinguishable from real** | Every candidate carries a `synthetic` flag; it flows to `Prospect.synthetic`; sourcing/cycle summaries report `real` vs `synthetic`; the dashboard + CLI label **DEMO DATA**. Synthetic generators are **gated off in production** (`allowSyntheticDiscovery`, default off in prod). [`ports.ts`](packages/integrations/src/ports.ts), [`config.ts`](packages/api/src/config.ts), [`context.ts`](packages/api/src/context.ts), [`Recruitment.tsx`](packages/web/src/pages/Recruitment.tsx) | `honesty.test.ts` |
| **Generic `?ref=`/`?via=` treated as affiliate / competitor proof** (`affiliate-detection.ts:21`) | Signals now carry **confidence** (named network = high, generic = low). "Runs affiliate links" requires a **high-confidence** signature. Competitor promotion counts only when the destination is **known**: a link **directly** to the competitor's domain, or a third-party redirector **resolved** to it — never assumed. [`affiliate-detection.ts`](packages/core/src/recruitment/affiliate-detection.ts) | `recruitment.test.ts` (direct vs redirector) |
| **Invented DA / engagement / reach / overlap → untrustworthy A/B/C** | Those signals are `number \| null`; **null = unknown** (no provider). The scorer **excludes** unknowns, renormalizes over what's known, and returns a **confidence** (share of weight backed by real signals) + `unknownFactors`. Enrichment no longer estimates DA/engagement from the domain string. [`scoring.ts`](packages/core/src/recruitment/scoring.ts), [`pipeline.ts`](packages/recruitment/src/pipeline.ts) | `recruitment.test.ts` (unknown-signal scoring) |
| **Email enrichment = pattern-guess + hashed "75% verified"** (`enrichment.ts:19`) **[revised Oct 2026]** | Enrichment **prefers real contact extraction** from the page (mailto: + visible addresses, junk-filtered) and verifies with a real **MX** check; pattern-guessing is a labeled fallback (`contactSource: "pattern-guess"`). [`web-evidence.ts`](packages/integrations/src/web-evidence.ts), [`pipeline.ts`](packages/recruitment/src/pipeline.ts) | `web-evidence.test.ts`, `honesty.test.ts` |
| **Real SERP/Hunter/proxy adapters never wired** (`context.ts:61`) | `createContext` wires them by env: `SERPAPI_KEY` → real SERP + page fetcher, `PROXY_URL` → rotating proxy, `HUNTER_API_KEY` → Hunter, plus `FetchRedirectResolver` + `MxEmailVerifier` whenever real discovery is on. No key → deterministic providers that self-label synthetic. [`context.ts`](packages/api/src/context.ts) | — |
| **Review UX didn't show the proof** | The prospect panel shows confidence, the exact competitor promoted, the page it was found on, each detected affiliate link (network + high/low + "resolved"), and the contact source — plus an explicit "unknown (no provider)" line. [`Recruitment.tsx`](packages/web/src/pages/Recruitment.tsx) | — |

**What still needs live keys** (cannot be exercised here): real SERP results, Hunter
lookups, MX/SMTP deliverability at scale, and proxy-routed scraping all require the
corresponding API keys/proxies. The code paths, adapters, and gating are in place and
unit-tested with mocks/deterministic providers; with keys set they run end-to-end with
no pipeline change. Backlink mining is wired to DataForSEO (`DATAFORSEO_LOGIN` /
`DATAFORSEO_PASSWORD`) and returns an honest empty result without it.

## Third review — outreach + discovery/enrichment audit (2026-07)

A multi-agent adversarial audit (7 subsystem auditors, every finding independently verified
against the code; 0 refuted) surfaced **50 confirmed findings** after the §16 outreach build.
**All 50 are remediated** across 12 commits (`6b5febf`→`b29d8f6`); the suite went 377 → **456**
green (root + web typecheck + vite build clean). Full per-finding detail + file/line evidence is
in [`docs/AUDIT-2026-07.md`](docs/AUDIT-2026-07.md); highlights by tier:

- **T0 "fabricated success" (the worst class):** a mailer `failed` result is no longer recorded
  as `sent` (no phantom sends, no billing, retryable); mailbox creds persist AES-256-GCM in the DB
  (`DbSecretStore`) so a restart can't silently fall back to the mock sender; the standalone worker
  builds the same full `AppContext` as the API (`packages/api/src/worker.ts`); the transactional
  ESP is env-wired (Resend/Postmark).
- **T1 reply-loop safety:** quoted-reply extraction never falls back to the raw email (killed the
  bottom-posted-"I'm interested"→global-suppression bug); tenant-scoped matching; Message-Id dedup
  on every inbound path; bare `STOP` honored; OOO snooze; a real public `/#/join/:merchantId` page.
- **T2 enforcement:** daily-cap/warmup/auto-pause enforced on the CAMPAIGN's mailbox (not a
  sibling); `launchCampaign` obeys the same guards; SMTP bounce regex no longer matches port 587;
  unsubscribe link HMAC-signed + confirm-on-GET; circuit breaker uses a rolling window and counts
  complaints ≠ unsubscribes; the GDPR/geo gate is armed (enrich persists ISO geo).
- **T4/T5 discovery + enrichment correctness:** no synthetic SERP in prod; bare `amzn.to` detected;
  exact-merchant-id backlink filter (was a substring LIKE); youtube `/watch` no longer collapses;
  no identity over-merge (video/share URLs aren't owned handles); Hunter verify outranks domain MX.
- **#22 mail-rail parity:** Graph sends raw-MIME (List-Unsubscribe + threading survive) + maps
  recipient errors to bounced.
- **New capabilities (verified worth building):** bulk import (prospects + affiliate roster — also
  guards a merchant's own affiliates from cold email); IG/TikTok discovery; content-freshness;
  merchant `bookingUrl` (removed the fabricated `cal.vantage.dev` stub URL); audience-quality flag.

**⚠️ Remediated ≠ go-live validated.** As with the first two reviews, everything above is fixed IN
CODE and tested **offline against mocks/stubs** — **no provider key has ever run.** Real SMTP/IMAP/
OAuth/ESP/DataForSEO/SERP/Hunter/scrape/proxy behavior and the Postgres path are UNVALIDATED, and
the optional deps (`nodemailer imapflow mailparser`, playwright) aren't installed. The
"unsafe-by-construction" bugs are gone; production validation is a keyed on-the-box pass — see
**Tier 0 — go-live validation** in `CLAUDE.md`. Do not describe the system as "safe to point at
real prospects" until that pass is done.

## Fourth review — the whole repository, run for real (2026-10)

A full audit that ran the system: a clean install, the suite, a headless-browser pass over
every page, and the Postgres path on a real Postgres 16 for the first time. Four parallel
area reviews; every finding was reproduced or read end to end. Full list with evidence and
the fix log: [`docs/AUDIT-2026-10.md`](docs/AUDIT-2026-10.md).

**Why earlier fixes had looked finished.** The in-memory store never yields to the event
loop, so requests are serialized and a race cannot appear in the offline suite; mocks return
clean shapes; nothing loaded the web app in a browser. So "456 tests green" was true and
several guarantees were still false.

What changed, by area:

- **Money and persistence.** On Postgres, two simultaneous payout batches paid every
  affiliate twice and one order delivered five times became five commissions. Cause: the
  Postgres "transaction" was not bound to a connection, the in-memory one had no rollback,
  and nothing was unique or locked. Now: connection-bound transactions with rollback in both
  adapters, `db.withLock`, uniqueness declared once and enforced by both, payout paths under
  a per-merchant lock, a schema-validated postback. Also fixed: a refund during a pending
  batch was still paid; retry could pay twice; a negative entry was deducted twice; offer
  edits accepted a 2,000% rate; hold period and priority came from the wrong program; banned
  affiliates still earned; bonuses were re-earned after a reversal; self-referral detection
  never had a hash to compare.
- **No custody.** The mock payout rail ran in production and rails were platform-global.
  Now payouts are manual by default — export file, the merchant pays from their own account,
  mark paid or failed — and a rail can only run on one merchant's own credentials. Payout
  accounts and tax forms recorded by a merchant apply to that merchant only.
- **Security and deployment.** The unsubscribe endpoint rejected every real client (415);
  any tenant could create a platform-wide suppression; the inbound webhook was open when its
  secret was unset; the boot guard accepted placeholder secrets; team invitations could be
  hijacked by anyone who knew the address; magic links were reusable; impersonation gave a
  full cross-merchant affiliate session; the rate limiter trusted a client header; the compose
  file could not start its own worker. All fixed; the compose stack now builds and boots.
- **Web.** Settings crashed on load; the emailed affiliate sign-in link had no page; there
  was no error boundary; bulk import and team invitations had no screens; a batch of forms
  sent values the API always rejected. All fixed and checked in a browser.
- **Outreach.** Any SMTP 5xx suppressed the prospect; Gmail/Graph messages were malformed;
  OAuth mailboxes never saw replies; overlapping runs double-sent; one merchant's error
  stopped the scheduler for everyone, silently; a resolver error "sent" through the mock;
  autopilot did nothing; delivery-status mail was ignored. All fixed; follow-ups now hold for
  any mailbox whose replies cannot be read.
- **Discovery.** Real prospects received guessed addresses stamped verified; third-party
  addresses were adopted as contacts; the proxy silently went direct; sourcing re-ran every
  minute and then pruned itself after one cycle; measured engagement lowered a score;
  distinct creators merged. All fixed; outbound fetches go through one SSRF-safe guard.

The rows marked **[revised Oct 2026]** above, precisely:
- *Payouts paid twice*, *one transaction* — true only for one-at-a-time requests until now.
- *Self-referral* — the customer email hash was never written; it is now, where the
  integration supplies an email (a signed S2S postback only does if `customerRef` is one).
- *payoutValue bounded* — on create only until now; updates are validated too.
- *Tenant scope* — tenants can no longer create global suppressions at all.
- *SSRF* — was a hostname-literal check that followed redirects; now resolves DNS, re-checks
  every hop, and no URL is ever "delivered" without being sent.
- *Proxy* — `undici` was not a dependency, so the fetcher went direct; it is declared now and
  the fetch fails instead.
- *JWT secret / rate limiting* — the guard rejected one literal string and the limiter keyed
  on `X-Forwarded-For`; now a 32-character minimum with a placeholder denylist, and the real
  client address under `TRUST_PROXY`.
- *Email enrichment* — the pattern-guessing stub still ran for real prospects when no Hunter
  key was set; it now runs for demo prospects only.

## Still open

Deliberately deferred, or needing accounts or a product decision. The working list is the
"Next steps" section of `CLAUDE.md`.

- **Keyed validation.** No third-party provider has been exercised.
- **Cloudflare edge.** The Workers KV sync and queue consumer are not implemented; the Node
  edge redirects every merchant to one `EDGE_DEFAULT_DEST`.
- **Mail.** Gmail-via-Google reply reading; a complaint (FBL) feed.
- **Money.** Partial refunds; asynchronous rail settlement; non-two-decimal currencies;
  whether draft or paused programs should earn.
- **Scale.** The Postgres adapter filters in the process; the rate limiter is per process.
- **Signup.** Merchant signup does not verify the email address.
- **Tooling.** No web test runner; six dev-tool advisories (vitest/vite) need major upgrades;
  datacenter/VPN IP detection is inactive.
