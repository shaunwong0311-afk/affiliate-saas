# Security & correctness remediation

In response to a series of adversarial reviews (three so far — see the sections below; the
2026-07 outreach/discovery audit is the newest and is detailed in `docs/AUDIT-2026-07.md`).
Each item links to the fix and, where applicable, a regression test. The suite now stands at
**456 tests** green; full monorepo typechecks; web typecheck + vite build clean.

> **All three reviews are fixed IN CODE and tested OFFLINE (mocks/stubs). No provider key has
> ever run** — real SMTP/IMAP/OAuth/ESP/SERP/DataForSEO/Hunter/scrape/proxy + Postgres are
> unvalidated until a keyed go-live pass (see `CLAUDE.md` → Tier 0). "Remediated" ≠ "production-
> validated"; don't overclaim.

## Critical — fixed

| Finding | Fix | Test |
|---|---|---|
| **Payouts paid twice** | Batch creation now **reserves** the funding ledger entries (`approved`→`processing`, stamped with the payout id) inside a transaction, so a second batch sees nothing; `approveAndDisburse` is **state-guarded** (only a `draft` batch disburses, re-approve → 409). [`payout-service.ts`](packages/api/src/services/payout-service.ts) | `payout.test.ts` (+ live probe: $287.30, not $574.60) |
| **Production persistence ignored** | `createDatabaseFromEnv` wires real Postgres when `USE_POSTGRES`/`DATABASE_URL` is set; API, edge, and worker all use it. [`bootstrap.ts`](packages/db/src/bootstrap.ts), [`server.ts`](packages/api/src/server.ts) | — |
| **Affiliate login = email only** | Replaced with a **magic link** emailed to the affiliate's inbox; the magic token is single-purpose and rejected as a session. [`auth.ts`](packages/api/src/routes/auth.ts) | `remediation.test.ts` |
| **Unsigned reply webhook** | HMAC-SHA256 over the **raw body** with the merchant secret, verified before processing. [`automation.ts`](packages/api/src/routes/automation.ts), raw-body capture in [`app.ts`](packages/api/src/app.ts) | `remediation.test.ts` |
| **Secrets exposed to viewers** | `postbackSecret` redacted from merchant reads (admin-only reveal endpoint); `passwordHash` stripped from `/auth/me`. [`sanitize.ts`](packages/api/src/sanitize.ts) | `remediation.test.ts` |
| **Money writes non-transactional** | The whole order→conversion→ledger→overrides write set runs in one `db.transaction`. [`conversion-pipeline.ts`](packages/api/src/services/conversion-pipeline.ts) | — |

## High-priority — fixed

- **Cross-customer attribution** — the merchant-wide last-click fallback is gone; the fallback is now scoped to the order's own customer. [`conversion-pipeline.ts`](packages/api/src/services/conversion-pipeline.ts)
- **Multi-program / reversal engine** — conversions now store `offerId`; reversals route to that offer's engine; code attribution selects an offer in the relationship's program (not the merchant's first). [`orders.ts`](packages/core/src/types/orders.ts), [`reversal.ts`](packages/api/src/services/reversal.ts), [`attribution.ts`](packages/core/src/attribution/attribution.ts)
- **Payout rails** — each payout disburses through its own affiliate's rail; unknown/unconfigured rails **fail closed** (no silent mock). Retries use a **stable** idempotency key. [`payouts.ts`](packages/integrations/src/payouts.ts)
- **Open redirect** — `?to=` is closed by default: same-host-as-destination unless an explicit allowlist is set. [`handler.ts`](packages/tracking-edge/src/handler.ts)
- **Fraud** — IP velocity is now windowed (last hour); self-referral compares the affiliate's email hash to the customer's. [`conversion-pipeline.ts`](packages/api/src/services/conversion-pipeline.ts)
- **Validation** — affiliate creation verifies program + sponsor ownership; public apply rejects draft/archived/invite-only; offer `payoutValue` is bounded (percentage ∈ (0,1], flat = integer cents); **MLM offers are rejected** (no silent zero-commission). [`affiliates.ts`](packages/api/src/routes/affiliates.ts), [`programs.ts`](packages/api/src/routes/programs.ts)
- **Tenant scope** — global suppressions are no longer enumerable cross-tenant; GDPR delete only redacts the global affiliate when no other merchant still uses it. [`recruitment.ts`](packages/api/src/routes/recruitment.ts), [`admin.ts`](packages/api/src/routes/admin.ts)
- **SSRF** — outbound webhooks are blocked from private/loopback/link-local/metadata targets, at delivery and at creation. [`webhooks.ts`](packages/api/src/services/webhooks.ts)

## Deployment / placeholders — fixed

- Worker entrypoint now builds deps and runs the scheduler + stage queue. [`worker.ts`](packages/recruitment/src/worker.ts)
- `tsx` moved to production deps (the Docker image no longer fails at startup). [`package.json`](package.json)
- DNS verification does **real** TXT lookups (SPF/DMARC) and fails closed; DKIM stays pending without a selector. [`integrations.ts`](packages/api/src/routes/integrations.ts)
- Real public **unsubscribe** endpoint; the outreach link points at it. [`ingestion.ts`](packages/api/src/routes/ingestion.ts)
- The proxy fetcher now actually routes through the proxy (undici `ProxyAgent`). [`http.ts`](packages/integrations/src/http.ts)
- SPA API base is build-time configurable (`VITE_API_BASE`). [`api.ts`](packages/web/src/api.ts)
- JWT secret must be set in production (boot fails on the dev default); basic per-IP rate limiting on auth + public webhook routes; entitlement enforcement wired on the metered sourcing route.

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
| **Email enrichment = pattern-guess + hashed "75% verified"** (`enrichment.ts:19`) | Enrichment **prefers real contact extraction** from the page (mailto: + visible addresses, junk-filtered) and verifies with a real **MX** check; pattern-guessing is a labeled fallback (`contactSource: "pattern-guess"`). [`web-evidence.ts`](packages/integrations/src/web-evidence.ts), [`pipeline.ts`](packages/recruitment/src/pipeline.ts) | `web-evidence.test.ts`, `honesty.test.ts` |
| **Real SERP/Hunter/proxy adapters never wired** (`context.ts:61`) | `createContext` wires them by env: `SERPAPI_KEY` → real SERP + page fetcher, `PROXY_URL` → rotating proxy, `HUNTER_API_KEY` → Hunter, plus `FetchRedirectResolver` + `MxEmailVerifier` whenever real discovery is on. No key → deterministic providers that self-label synthetic. [`context.ts`](packages/api/src/context.ts) | — |
| **Review UX didn't show the proof** | The prospect panel shows confidence, the exact competitor promoted, the page it was found on, each detected affiliate link (network + high/low + "resolved"), and the contact source — plus an explicit "unknown (no provider)" line. [`Recruitment.tsx`](packages/web/src/pages/Recruitment.tsx) | — |

**What still needs live keys** (cannot be exercised here): real SERP results, Hunter
lookups, MX/SMTP deliverability at scale, and proxy-routed scraping all require the
corresponding API keys/proxies. The code paths, adapters, and gating are in place and
unit-tested with mocks/deterministic providers; with keys set they run end-to-end with
no pipeline change. Backlink/competitor-backlink mining remains an honest empty result
until a backlink API (`BACKLINK_API_KEY`) is wired.

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

## Knowingly still open (not yet addressed)

Honest list — these were lower-severity or need infra:

- **Idempotency race**: the in-pipeline txn dedup is fast-path only; race safety relies on the `UNIQUE(merchant_id, txn_id)` index in `schema.sql` (Postgres). The in-memory adapter does not enforce it.
- **Cloudflare KV sync / Queue consumption** remain skeletons (the Node edge path shares Postgres; the Workers KV/Queue production wiring is documented but not implemented).
- **Real provider adapters** (Stripe/PayPal/Gmail/calendar/billing) are still skeletons; the dev mocks report success by design. Production must wire and fail-closed each one.
- **Datacenter/VPN IP detection** is inactive (needs an IP-intelligence provider).
- **Real SERP/Hunter/proxy/backlink discovery** needs API keys (see above); without them discovery runs in deterministic/demo mode (clearly labeled) or returns empty.
- **No Postgres-backed integration tests, lint config, or UI tests** yet.
