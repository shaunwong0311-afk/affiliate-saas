# Deployment topology

A **hybrid**, per Section 11 of the build plan: Cloudflare owns the latency-sensitive,
globally distributed edge; Hetzner owns the heavy, stateful origin. This is the
physical expression of architectural principle #5 — the edge-isolated tracking hot
path. The redirect must never sit behind a single-region origin.

```
                ┌──────────────────────── Cloudflare edge ────────────────────────┐
 end-customer → │  Workers redirect  ·  Pages (SPA front-end)  ·  R2 assets        │
 click / UI     │  DNS / CDN / WAF in front of everything (hides the origin IP)    │
                └───────────────┬─────────────────────────────────────────────────┘
                                │ API calls + click queue
                ┌───────────────▼──────────── Hetzner origin ─────────────────────┐
                │  API (Fastify)  ·  Postgres (the ledger)  ·  Redis (the queue)    │
                │  Recruitment pipeline + Playwright scrape/enrich/LLM/send workers │
                └───────────────┬─────────────────────────────────────────────────┘
                                │ scrape · send · pay
                                ▼  external services (proxies, ESP, payout rails, LLM)
```

## Edge — Cloudflare

| Concern | Service | Notes |
|---|---|---|
| Front-end | **Pages** | the SPA in `packages/web`, built with `npm run build -w @affiliate/web`, hitting the API. |
| Redirect | **Workers** | `packages/tracking-edge/src/worker.ts`. Resolves the link from **Workers KV** (`LINKS`, synced by the backend), mints the `click_id`, sets the cookie, 302s, and pushes the click onto a **Queue** (`CLICKS`) the pipeline drains. Deploy with `deploy/wrangler.toml`. |
| Assets | **R2** | creatives, agreements, email bodies, screenshots, prospect-source evidence. |
| Shield | **DNS/CDN/WAF** | in front of the origin too — hides its IP and shields the API + postback endpoint. |

## Origin — Hetzner

The API, Postgres (the ledger), Redis (the queue), and the full recruitment
pipeline including Playwright scrapers. Cheap, beefy compute for long-running
scrape / enrich / LLM / send jobs. Run with `deploy/docker-compose.yml`.

## Hetzner-specific operational rules (these bite this product in particular)

1. **Never send email from the box IP.** Hetzner ranges carry poor sending
   reputation. Recruitment sends already go through the merchant's connected
   Gmail / Microsoft mailbox (so SMTP is Google/Microsoft). Transactional email
   routes through a reputable ESP — Postmark / SES / **Resend** (see
   `@affiliate/integrations` `TransactionalMailer`, `ESP_PROVIDER`). No mail ever
   leaves the box's own IP.
2. **Scrape through rotating / residential proxies, never the box IP.** Datacenter
   IPs get blocked fast. A hard requirement once sourcing workers run on Hetzner
   (`PROXY_URL`).
3. **Back the ledger up off-box.** Money-critical data on a single self-managed
   Postgres with no off-box backup is the one unrecoverable failure. Automated
   **PITR backups to R2/S3** at minimum; consider **managed Postgres for the money
   store** even while the rest stays on Hetzner. (Risk #5 in the plan.)
4. **No Asian region.** Hetzner is EU/US only (~150–250ms from Asia — fine for a
   dashboard, irrelevant for redirects which are on the edge). Pick US or EU by
   where the merchants are.
5. **Single origin is a SPOF for the API/pipeline.** Fine to start; plan to split
   Postgres and the workers onto separate hosts as load grows.

## Persistence: in-memory vs Postgres

The app's **default runtime is the in-memory store** (`createMemoryDatabase`), so
everything boots and the demo/tests run with zero external services. For
production set `DATABASE_URL` and switch the adapter to
`createPostgresDatabase(sql)` (`packages/db/src/postgres.ts`); the normalized
relational schema for the analytics/reporting surface is in
`packages/db/src/schema.sql`. The queue is `InMemoryQueue` by default; wire a
BullMQ/Redis adapter behind the same `JobQueue` interface for production.

## Quick start (local origin)

```bash
cp .env.example .env
docker compose -f deploy/docker-compose.yml up --build   # postgres + redis + api + worker + edge
# or, no Docker, in-memory:
npm run api      # API on :8787
npm run edge     # tracking edge on :8788
npm run web:dev  # SPA on :5173
```
