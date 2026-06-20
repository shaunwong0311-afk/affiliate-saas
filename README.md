# Vantage — Affiliate Recruitment Platform

A merchant-focused affiliate program management platform where **tracking is table
stakes and recruitment is the wedge**. Built on a shared substrate with a
**pluggable commission engine**, so the affiliate engine ships first and an
MLM/direct-selling engine remains a clean future option on the same chassis.

This is a full, runnable implementation of the [build plan](./affiliate-platform-build-plan%20%281%29.md):
a TypeScript monorepo with a pure domain core, a multi-tenant API, an edge tracking
hot path, a six-stage recruitment engine, and a React dashboard + affiliate portal.

> **The whole system runs with zero external services.** The default persistence is
> an in-memory store and every external integration (Stripe, PayPal, Gmail,
> scrapers, LLM) sits behind an adapter with a deterministic stub. `npm run demo`
> exercises the entire money path in one process.

---

## Quick start

```bash
npm install
npm test                 # 81 tests across all packages
npm run demo             # end-to-end narrative: seed → commission → override → clawback → payouts → recruitment

# run the stack (3 terminals)
npm run api              # API            → http://localhost:8787
npm run edge             # tracking edge  → http://localhost:8788/c/:code
npm run web:dev          # dashboard+portal → http://localhost:5173
```

To populate the dashboards with demo data, start the API seeded:

```bash
# bash
SEED_DEMO=true npm run api
# PowerShell
$env:SEED_DEMO="true"; npm run api
```

Then sign in at the web app with **owner@demo.test / demo1234**.

---

## Architecture

Three tiers — a shared **substrate**, **pluggable commission engines** above it, and
**merchant-facing features** on top — with the recruitment engine running as a
parallel pipeline that feeds the identity graph.

```
packages/
  core/           Pure domain — no I/O, fully unit-tested. The value lives here.
                  · commission-engine seam (the interface) + affiliate engine + MLM stub
                  · append-only ledger + reversal/clawback math
                  · attribution (link + code, configurable priority)
                  · fraud heuristics · prospect scoring · state machine
                  · affiliate-link-pattern detection · HMAC postback signing · money
  db/             Repository ports + in-memory adapter (default) + Postgres adapter
                  + the normalized schema.sql (Section 10 data model)
  integrations/   Adapters behind interfaces, each with a working stub:
                  ingestion (Shopify/Woo/Stripe/S2S) · payout rails (Stripe/PayPal/Wise)
                  · mailbox (Gmail/MS Graph) · transactional ESP · enrichment · discovery
                  · LLM + embeddings · secret store
  tracking-edge/  Cloudflare Workers-style redirect hot path (KV resolve → mint
                  click_id → cookie → 302 → async click to queue). Runs as a Worker in
                  prod and a Node service locally — same handler.
  recruitment/    The wedge: an AUTONOMOUS from-scratch engine — scheduler + durable
                  queue, per-prospect state machine, six pipeline stages (source →
                  enrich → score → outreach → reply → loop), multi-touch sequencing,
                  two-track reply router (self-serve vs AI-SDR + meeting booking),
                  deliverability circuit breaker, and a live closed loop (learned
                  scoring + source-yield pruning). See **RECRUITMENT.md**.
  api/            Fastify app: JWT + API-key auth, tenant-scoped RBAC, the substrate
                  write path (ingest → attribution → fraud → engine → ledger), payout
                  orchestration, and the full management surface (~110 endpoints).
  web/            React + Vite SPA — merchant dashboard + affiliate portal.
deploy/           Dockerfile, docker-compose, wrangler.toml. See DEPLOYMENT.md.
```

### The commission-engine seam (the load-bearing decision)

Commission calculation lives behind a narrow interface (`packages/core/src/engine/types.ts`).
The substrate assembles a context (all reads), calls the engine (pure compute), and
writes the returned money events to the ledger (all writes):

```ts
interface CommissionEngine {
  onOrder(ctx)    -> CommissionEvent[]   // event-driven (affiliate)
  runCycle(ctx)   -> CommissionEvent[]   // batch (MLM commission runs)
  onReversal(ctx) -> ReversalEvent[]     // clawback cascade
  qualify(ctx)    -> Qualification       // tiers / ranks
}
```

The **affiliate engine** applies a rate, walks the sponsor pointer up one level for a
two-tier override, and emits events. The **MLM engine is a deliberate stub** — it
proves the seam (a second engine drops in without touching the substrate) and
documents the future vertical, but is not built.

### What's real vs. stubbed

| Real & tested | Stubbed (adapter present, swap for prod) |
|---|---|
| Commission math: rates, tiers, bonuses, two-tier overrides, caps, basis rules | Stripe/PayPal/Wise payout rails (mock rail is the default) |
| Append-only ledger + reversal/clawback (incl. post-payout negative balances) | Gmail/MS Graph mailbox send (mock mailer) |
| Attribution (deterministic click_id + last-click fallback + code, priority) | Hunter/Apollo email finding (deterministic stub) |
| HMAC-signed S2S postback verification + provider order normalization | Playwright scrapers (deterministic candidate generators) |
| Fraud heuristics, self-referral & circular-sponsorship guards | LLM personalization + reply classification (deterministic stub) |
| Recruitment scoring + tiers + explainability + state machine | Postgres/Redis (in-memory adapter is the default runtime) |
| Edge redirect hot path (click_id mint, cookie, 302, async write) | Workers KV / Queue bindings (Node adapters for local) |
| Tenant-scoped RBAC, payout tax-gating, entitlements | Transactional ESP send (console mailer) |

Everything in the left column is verified by the 81-test suite, including a full
HTTP end-to-end test of the money path in `packages/api/test/pipeline.test.ts`.

---

## How the money path works (one order, end to end)

1. **Click** → edge mints a UUIDv7 `click_id`, sets a first-party cookie, 302s, and
   writes the click asynchronously (never blocking the redirect).
2. **Conversion** → the merchant's server sends an HMAC-signed postback (or a
   Shopify/Woo/Stripe webhook is normalized). The signature is verified before the
   order is accepted.
3. **Attribution** → resolve deterministically on `click_id`, else last-click within
   the offer window, else the code used at checkout; a per-program priority rule
   breaks link-vs-code ties.
4. **Fraud** → IP velocity, click→conversion timing, reversal rate, self-referral and
   circular-sponsorship checks produce an approve / review / reject decision.
5. **Engine** → the offer's `engine` routes to the affiliate engine, which computes a
   commission for the seller and, if the seller was sponsored, a two-tier override for
   the recruiter.
6. **Ledger** → events are written append-only as `pending`/`approved` with an
   `available_at` from the program hold period. A refund cascades reversals.
7. **Payout** → balances are derived from the ledger, gated on a tax form being on
   file and a minimum threshold, batched, approved by the merchant, and disbursed
   through the connected rail — orchestration without custody.

Run `npm run demo` to watch all of this compute against seeded data.

---

## Testing & types

```bash
npm test          # vitest, 81 tests
npm run typecheck # tsc -b across all backend packages (web: tsc --noEmit)
```

## Deployment

Hybrid topology — Cloudflare edge (Pages SPA + Workers redirect + R2 + WAF) over a
Hetzner origin (API, Postgres ledger, Redis queue, Playwright pipeline). See
[DEPLOYMENT.md](./DEPLOYMENT.md) for the topology diagram and the origin-specific
operational rules (never send mail from the box IP, scrape through rotating proxies,
back the ledger up off-box).

## Non-goals (per the thesis)

Not the merchant of record · not building MLM now (the seam keeps it a future option)
· not an affiliate-side marketplace now (the graph accumulates as a byproduct of
recruitment, exposable later without a cold-start gamble).

_Not legal/tax advice. Confirm outreach-compliance, payout, and tax rules before
scaling._
