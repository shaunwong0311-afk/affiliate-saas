# Deployment

A **hybrid**, per Section 11 of the build plan: Cloudflare owns the latency-sensitive,
globally distributed edge; a single origin owns the stateful work.

```
                ┌──────────────────────── Cloudflare edge ────────────────────────┐
 end-customer → │  Workers redirect  ·  Pages (SPA front-end)  ·  DNS / CDN / WAF  │
 click / UI     └───────────────┬─────────────────────────────────────────────────┘
                                │ API calls
                ┌───────────────▼──────────────── origin ─────────────────────────┐
                │  API (Fastify)  ·  worker (scheduler)  ·  Node edge  ·  Postgres  │
                └───────────────┬─────────────────────────────────────────────────┘
                                │ scrape · send · notify
                                ▼  external services (proxies, mailboxes, ESP, LLM)
```

## What is built and what is not

| Piece | State |
|---|---|
| Origin: API, worker, Node tracking edge, Postgres | Built. `deploy/docker-compose.yml` builds and boots it; verified locally (all containers healthy, a link created through the API redirects through the edge and is recorded). |
| Front-end on Pages | `npm run build -w @affiliate/web` with `VITE_API_BASE` set to the API origin. Not deployed anywhere yet. |
| Redirect on Workers | `packages/tracking-edge/src/worker.ts` + `deploy/wrangler.toml` are a **template**: the KV namespace id and route are placeholders, and the backend's KV sync and the queue consumer are **not implemented**. Until they are, use the Node edge at the origin. |
| Queue | In-process (`InMemoryQueue`). There is no Redis; no code reads `REDIS_URL`. |

## Running the origin

```bash
cp .env.example .env     # set the required values below
docker compose --env-file .env -f deploy/docker-compose.yml up --build
```

`--env-file .env` is required: the compose file lives in `deploy/`, so without it compose
looks for `deploy/.env`.

Required (compose stops with a message if one is missing; the app refuses to boot on a weak one):

| Variable | Value |
|---|---|
| `POSTGRES_PASSWORD` | URL-safe, e.g. `openssl rand -hex 24` |
| `JWT_SECRET` | at least 32 random characters, e.g. `openssl rand -hex 32` — placeholders are refused |
| `EDGE_DEFAULT_DEST` | the storefront URL tracking links redirect to |

Set before going live:

| Variable | Why |
|---|---|
| `CORS_ORIGINS`, `PUBLIC_API_URL`, `TRACKING_BASE_URL` | They end up in emailed links (sign-in, invitations, unsubscribe, tracking). The first CORS origin is the web app's address. |
| `TRUST_PROXY` | Behind a reverse proxy or CDN, the proxy's address/CIDR list. Without it every client shares one rate-limit bucket. |
| `RESEND_API_KEY` or `POSTMARK_SERVER_TOKEN`, and `TRANSACTIONAL_FROM` | Sign-in links, activation emails and team invitations are not delivered without an ESP. |
| `INBOUND_WEBHOOK_SECRET` | `POST /webhooks/inbound` answers 503 in production until it is set. |
| `SECRETS_ENC_KEY` | Set once, before connecting mailboxes. It defaults to a value derived from `JWT_SECRET`, so rotating `JWT_SECRET` later would otherwise make stored mailbox credentials unreadable. |
| `PROXY_URL` | Scraping (see rule 2). |

What the compose file does:
- One image (`deploy/Dockerfile`, `npm ci --omit=dev`, runs as the unprivileged `node` user)
  for three processes: API, worker (`packages/api/src/worker.ts`), Node edge.
- All three get the same `DATABASE_URL`. An edge without it resolves no links; a worker
  without it works on an empty private store.
- The API and edge are published on `127.0.0.1` by default (`BIND_ADDRESS`); put a
  TLS-terminating proxy or tunnel in front. Postgres is published on loopback only.
- The scheduler runs in the worker. Never also set `SCHEDULER=true` on the API.
- Health checks on every service; the worker and edge wait for a healthy API (the first
  process to connect creates the tables).

Without Docker, in-memory: `npm run api`, `npm run edge`, `npm run web:dev`.

## Persistence

- No `DATABASE_URL`: an in-memory store. Nothing survives a restart, and each process has its
  own. Development and tests only.
- `DATABASE_URL` set: Postgres. The adapter creates one JSONB document table per collection
  (`kv_*`) at boot, with unique indexes for the rules in `packages/db/src/constraints.ts`
  (for example one order per merchant and transaction id). Boot fails, naming the rule, if
  existing rows violate one.
- `packages/db/src/schema.sql` is a reference sketch of a normalized model. **Nothing applies
  it**; do not run it against a live database.
- Transactions are bound to one connection and roll back on error; `withLock` uses a Postgres
  advisory lock, so payout batches, sends and single-use links stay exact across processes.
- Queries are not pushed down yet (`find` reads the table and filters in the process). Fine
  for early use; it is the first scaling work to do.
- `SEED_DEMO=true` is idempotent, but do not set it in production.

## Running more than one of anything

- **Worker:** exactly one. Two schedulers would both try to send (the per-merchant lock stops
  double sends, but there is no reason to run two).
- **API:** several instances are safe for data (locks and uniqueness are in the database).
  The rate limiter is per process, so limits multiply by the number of instances — front them
  with a shared limiter if that matters.

## Operational rules (these bite this product in particular)

1. **Never send email from the origin's IP.** Recruitment mail leaves through the merchant's
   own mailbox (SMTP, or Microsoft Graph / Gmail over OAuth). Transactional mail goes through
   an ESP. With no ESP key configured, production does not pretend to send.
2. **Scrape through rotating or residential proxies.** Datacenter IPs are blocked fast. With
   `PROXY_URL` set, a fetch that cannot go through a proxy fails — it never falls back to
   the origin's IP. Fetches of URLs taken from pages or tenants refuse internal addresses.
3. **Back the database up off-box.** Money-critical data on one self-managed Postgres with no
   off-box backup is the one unrecoverable failure. PITR backups to R2/S3 at minimum; consider
   managed Postgres.
4. **Pick the region for the merchants.** The dashboard tolerates distance; redirects belong
   on the edge once the Workers path is built.
5. **A single origin is a single point of failure.** Fine to start; plan to move Postgres and
   the worker to separate hosts as load grows.

## Before real traffic

The stack has been booted and exercised locally, with no third-party accounts. The keyed
validation list is in `CLAUDE.md` under "Next steps → Tier 0". Until it is done, treat a
deployment as a staging environment.
