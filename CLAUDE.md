# CLAUDE.md — affiliate-saas project guide

Read this first each session. It's the durable map of what this project is, how it's
built, how to run it, and where the recent (heavily-worked) recruitment/discovery
system lives. Deeper detail: `README.md`, `RECRUITMENT.md`, `DEPLOYMENT.md`,
`REMEDIATION.md`, `docs/PROFILE-GRAPH.md`, and the original `affiliate-platform-build-plan (1).md`.

## What this is

A recruitment-wedge **affiliate SaaS platform**. Thesis: tracking/payouts are table
stakes; **recruitment is the wedge** — autonomously *finding quality affiliates* for
merchants. Built on a shared substrate with a **pluggable commission engine**
(affiliate engine first; MLM a deliberate stub proving the seam).

Runs with **zero external services** by default (in-memory DB; every external
integration sits behind an adapter with a deterministic stub). Real providers swap in
by setting env keys — see **Provider keys** below. Nothing external is wired unless a
key is set; without keys the system runs on labeled **demo data**, never fabricated
real claims.

## Monorepo layout (npm workspaces, TypeScript, ESM with `.js` import specifiers)

| Package | Role |
|---|---|
| `packages/core` | Pure domain: commission-engine seam, ledger, attribution, fraud, **scoring**, **affiliate-link detection**, **identity graph** (`profile/identity.ts`), **affiliate-network registry** (`profile/affiliate-networks.ts`). Fully unit-tested, no I/O. |
| `packages/db` | Repo ports + in-memory (default) and Postgres adapters. Add a collection in `ports.ts` + `memory.ts` + `postgres.ts` (DDL auto-generated from `TABLES`). Entities in `entities.ts`. |
| `packages/integrations` | Every external adapter + its deterministic stub: discovery (SERP/backlink/customer), enrichers, email find/verify, redirect resolver, mailbox/ESP, payout rails, LLM, secrets, web-evidence, query-strategy, calendar. |
| `packages/recruitment` | The recruitment engine: 6-stage pipeline, planner, frontier (recursive), sequencing, reply-router, deliverability, learning, automation cycle, worker/scheduler. Structural subset of the API's `AppContext` (no circular dep). |
| `packages/tracking-edge` | Cloudflare-Workers-style click redirect (also runs as Node). |
| `packages/api` | Fastify. JWT + API-key auth, tenant RBAC, the substrate write-path, ~110 management routes, `context.ts` (the DI container wiring all adapters by env). |
| `packages/web` | React + Vite dashboard + affiliate portal. Dark "operator console" aesthetic. Hash router in `App.tsx`; pages in `src/pages/`; shared UI in `src/ui.tsx`; theme in `src/styles.css`. |

## Run it

```bash
npm test                                  # vitest — full suite (196+ tests)
npm run typecheck                          # tsc -b (root graph: NOT web)
npm run typecheck -w @affiliate/web        # web is a separate tsc --noEmit
npm run demo                               # end-to-end console narrative (no servers) — fastest way to see the engine
SEED_DEMO=true npm run api                 # API :8787, seeds a demo tenant, PRINTS the login
npm run edge                               # tracking edge :8788
npm run web:dev                            # dashboard :5173 (Vite proxies /api → :8787)
```
- **Windows note:** the user is on Windows; in PowerShell use `$env:SEED_DEMO="true"; npm run api`. The Bash tool is Git Bash (POSIX) — `SEED_DEMO=true npm run api` works there.
- **Seeded demo login:** `owner@demo.test` / `demo1234` (merchant "Lumen Skincare", competitors `glowrival.com`, `dewdrop.com`).
- Tests/typecheck must stay green before committing. Commit/push only when asked; author is `shaunwong0311`; remote `shaunwong0311-afk/affiliate-saas`; commits co-authored by Claude.

## Provider keys (this is how you make discovery REAL)

All optional. Absent → deterministic stub / honest empty / labeled demo. Set in env
before `npm run api` (see `.env.example`). Each is gated in `packages/api/src/context.ts`.

| Env | Enables | Notes |
|---|---|---|
| `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` | **Real competitor backlink mining** (the warmest source) + the recursive frontier | Pay-as-you-go, ~$0.05/1k backlinks (≈100× cheaper than Ahrefs). `BacklinkDiscoverySource` + `DataForSEOBacklinkProvider`. |
| `SERPAPI_KEY` | Real SERP discovery (`SerpApiProvider`); also enables the proxy/direct page fetcher, redirect resolver, MX verifier, and contact-link following | Without it, SERP runs the deterministic generator (synthetic). |
| `PROXY_URL` | Rotating/residential proxy for scraping (never the box IP) | Comma-separated pool. |
| `BROWSER_FETCH` | Headless-browser (Playwright) fetching for JS-rendered pages + passing JS anti-bot challenges (Cloudflare). Escalates static→browser only when a page looks blocked. | Optional dep: `npm install playwright && npx playwright install chromium`. `EscalatingFetcher`/`PlaywrightFetcher` in `integrations/browser-fetch.ts`. |
| `HUNTER_API_KEY` | Real email finding/verification (`HunterFinder`) | Fallback after real page-extraction; MX verify is free. |
| `SCRAPE_API_URL` (+ `SCRAPE_API_KEY`) | IG/TikTok/X public follower + engagement via a scraping-API actor (`ScrapeMetricsEnricher`) | Recommended vendor: ScrapeCreators or Social Fetch (pay-as-you-go). Demographics deferred. |
| `YOUTUBE_API_KEY` | Real YouTube reach + engagement (`YouTubeEnricher`, free Data API) | subs + recent-video like/comment/view ratios + country. |
| `ANTHROPIC_API_KEY` | Real LLM (AI-SDR + personalization), Claude Opus 4.8 | Else `DeterministicLlm`. |
| `ALLOW_SYNTHETIC_DISCOVERY` | Whether deterministic/demo sources run | Default: true outside prod, FALSE in prod (so a deployed instance never invents affiliates). |
| `USE_POSTGRES` / `DATABASE_URL` | Postgres-backed shared store (else in-memory) | API/edge/worker share it. |
| `SEED_DEMO`, `SCHEDULER`, `NODE_ENV`, `JWT_SECRET`, `CORS_ORIGINS`, `PUBLIC_API_URL` | dev seeding / in-process scheduler / prod hardening | In prod `JWT_SECRET` must not be the dev default (boot fails). |

### Wiring DataForSEO specifically
1. Make a DataForSEO account → get the API login (email) + password (from the dashboard; it's a separate API password, not your account password). $100 min balance, usable across their APIs.
2. `$env:DATAFORSEO_LOGIN="you@email"; $env:DATAFORSEO_PASSWORD="..."; $env:SEED_DEMO="true"; npm run api` (PowerShell).
3. Now backlink mining + the recursive frontier + the Niche Map run on real data instead of the deterministic generator. (Pair with `SERPAPI_KEY` so affiliate pages are actually fetched for the frontier's co-promotion expansion.)

## The recruitment / discovery system (where ~all recent work is)

Six stages: **source → enrich → score → outreach → reply → closed-loop**. Operating
model is **"L4 with two HITL gates"** (A-tier outreach approval + warm-reply meeting
handoff). Full detail in `RECRUITMENT.md`. The discovery half is the most built-out:

- **Discovery sources** (`integrations/discovery-real.ts`, `discovery.ts`) behind the `DiscoverySource` port: `SerpDiscoverySource` (real SERP + proxy fetch, deterministic fallback), `BacklinkDiscoverySource` (competitor-affiliate mining), `DbCustomerMiningSource` (first-party orders), synthetic generators (gated off in prod).
- **Query strategy** (`integrations/query-strategy.ts`): `buildDiscoveryQueries` turns the ICP into a prioritized, deduped, capped query set — competitor mining first, then buyer-intent, then **platform-targeted** queries (`site:youtube.com`, `site:substack.com`, …) that reach walled platforms via SERP. SERP source does **platform-aware dedup** (distinct creators on one host don't collapse) and sets `channelUrl` for social hits.
- **Discovery planner** (`recruitment/discovery-planner.ts`): `planDiscovery` — the "what to do" brain. Inspects the merchant (competitors? orders?) + available sources, emits a **prioritized plan** (warmest first), **skips inapplicable** sources with a reason, plus notes. `runSourcing` plans first, runs in that order, returns the plan in its summary.
- **Affiliate-link detection** (`core/recruitment/affiliate-detection.ts`): confidence-aware — HIGH (named network) vs LOW (generic `?ref=`). `promotesCompetitor` uses **destination certainty** (direct competitor-domain link, or a redirect resolved to it — never assumed).
- **Affiliate-network registry** (`core/profile/affiliate-networks.ts`): ~15 networks (ShareASale, Awin, CJ, Rakuten, Impact vanity, ClickBank, …). `identifyProgram(url)` → `{network, merchantId|vanityHost}`; `backlinkTargetsFor(program)` → the precise backlink queries (vanity host, or network domain filtered by merchant id); `parseProgramInput(text)` → forgiving manual entry; `competitorHostsFromLinks(links)` → the **other merchants an affiliate promotes** (recursive signal); `merchantDomainFromLink(url)` → resolves shared-network links to the brand domain via the destination param (`urllink`/`murl`/`ued`).
- **Competitor program resolver** (`integrations/discovery-real.ts` `CompetitorProgramResolver`): reads the competitor's own site (`/affiliates`, `/partners`) to auto-detect their network + merchant id; manual overrides win; cached.
- **Identity graph** (`core/profile/identity.ts`): unifies one creator across platforms from the links they published, with provenance + confidence; surfaced on `Prospect.evidence.profile`. Built in `discover`, augmented in `enrich` from bio-aggregator/contact pages.
- **Audience enrichers** (`integrations/enrichers.ts`) behind `AccountEnricher` + `EnricherRegistry`: `YouTubeEnricher` (free), `ScrapeMetricsEnricher` (IG/TikTok/X, key-gated), `OnPageSubscriberEnricher` (Substack), wrapped in `CachingEnricher` (TTL cache → don't re-pay per creator). Fills real `reach`/`engagement` (else null — unknown stays null, scoring renormalizes + reports confidence).
- **Recursive frontier** (`recruitment/frontier.ts` `expandFrontier`): the snowball — competitor → mine affiliates → read their *other* affiliate links → promote frequently co-promoted merchants as new seeds → repeat. Persisted in `frontierMerchants` (the visited set). HARD-CAPPED per cycle (seeds, expansions, new seeds, depth, min co-promotions). Wired into `autonomousCycle`. Surfaced as the **Niche Map** (`web/pages/NicheMap.tsx`, route `/niche-map`) — interactive radial graph (pan/zoom/hover/click).
- **Contact extraction** (`integrations/web-evidence.ts`): real emails from page HTML incl. obfuscation (`at`/`dot`, HTML entities, Cloudflare `cfemail`); `discoverContactUrls` (Linktree/contact/YT-About) followed in enrich; `detectsContactForm` → HITL "paste this draft" path (no auto-submit).
- **Closed loop** (`recruitment/learning.ts`, `service.ts`): producer outcomes reweight scoring (`weightsForMerchant`) and prune low-yield sources.

`ingestCandidate` (`recruitment/pipeline.ts`) is the shared candidate→prospect insertion used by both `discover` and the frontier.

## Honesty discipline (a hard rule — see REMEDIATION.md)

Two adversarial reviews were remediated. The standing rule: **produce evidence-backed
real data OR label it demo — never fabricate.** Every prospect carries `synthetic`;
provider-backed signals are `null` when no provider is wired (excluded from scoring,
surfaced as confidence + `unknownFactors`); failed fetches record zero, not invented,
links. Keep this discipline in all discovery/enrichment work.

## Conventions

- ESM throughout; import with `.js` specifiers even from `.ts`.
- Ports-and-adapters: define the port + a deterministic stub, gate the real adapter by env key in `context.ts`. Money/compliance code is only as good as these adapters — keep them explicit and individually testable.
- Web pages are PascalCase files (`Recruitment.tsx`), imported into `App.tsx`'s `MERCHANT_NAV` + `ROUTES`. (`App.tsx` casing was fixed from `app.tsx` — keep it `App`.)
- Frontend aesthetic: dark, refined, distinctive (see the global `~/.claude/CLAUDE.md` design guidance). Theme vars in `styles.css` (`--ink-*`, `--acc` lime, `--line`).
- Add tests for new logic; prefer the deterministic stubs / injected mocks so tests run offline.

## Current state (as of this writing)

All built and green (**205 tests**, root + web typecheck clean, demo runs). The full
**discovery + enrich + score + recursive-frontier** stack exists end-to-end behind
ports; it runs on labeled demo data until provider keys are set. Recent additions this
session (all committed): DataForSEO `one_per_domain` cost strategy + apex
affiliate-marker filter (`AFFILIATE_MARKERS`); `ingestCandidate` extracted + shared;
**homepage-fetch-in-enrich** (backlink-mined prospects fetch their own homepage so
email/identity-graph/affiliate-links/contact all populate — they're now first-class);
**headless-browser fetching** (`PlaywrightFetcher`/`EscalatingFetcher`/`looksBlocked`
in `integrations/browser-fetch.ts`, env `BROWSER_FETCH`) that escalates static→browser
only when a page looks blocked (passes Cloudflare JS challenges).

## Next steps (priority tiers — what to work on)

The discovery/enrichment HALF is deep and done; the **act-on-it half** (send → close →
pay) still has stub adapters. Recommended order:

**Tier 1 — go live (setup, not building):** set provider keys on the box
(`DATAFORSEO_LOGIN/PASSWORD` + `SERPAPI_KEY` + `PROXY_URL`, `BROWSER_FETCH=true` after
`npm install playwright`); `USE_POSTGRES`/`DATABASE_URL`; prod hardening
(`JWT_SECRET`, `NODE_ENV=production`, `ALLOW_SYNTHETIC_DISCOVERY=false`); deploy per
`DEPLOYMENT.md` (one small VPS/Hetzner origin + Cloudflare edge/static; the 3 Hetzner
rules: never email from box IP, scrape via proxies, back ledger off-box).

**Tier 2 — make the recruit→close→pay half REAL (biggest functional gap):**
- **Mailbox OAuth (Gmail / MS Graph)** so outreach actually sends as the merchant —
  currently a stub (`integrations/mailbox.ts`). *Highest-value next build.*
- **Calendar booking** (Cal.com / Google) for the A-tier meeting handoff — stub.
- **Payout rails** (Stripe Connect / PayPal / Wise) — stubs.

**Tier 3 — discovery polish / levers (we may keep iterating here):**
- **Per-merchant ICP override UI** for competitor program IDs (`parseProgramInput` +
  resolver overrides already support it; storage/field not wired).
- **LLM query expansion** (cheap — the LLM client exists).
- **Dedupe the frontier+enrich double-fetch** / crawl-history persistence.
- **Demo-mode frontier growth** (fake cross-promotion so the Niche Map snowballs
  offline) + Niche Map node animations.
- **Managed-unblocker rung** for CAPTCHA-hard targets (optional, behind the fetcher port).
- **Postgres integration tests**, CF KV/Queue wiring, datacenter-IP detection — see
  REMEDIATION.md "still open".
