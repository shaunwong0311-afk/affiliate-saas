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

All built and green (**456 tests**, root + web typecheck clean, vite build clean, demo runs).
The full **discovery + enrich + score + recursive-frontier** AND the **outreach/recruit→close**
half now exist end-to-end behind ports; runs on labeled demo data until keys are set.

A **multi-agent adversarial audit was run and fully remediated** — see `docs/AUDIT-2026-07.md`
(all 50 verified findings fixed across 12 commits). IN CODE, these load-bearing outcomes are now
correct — **verified OFFLINE against mocks/stubs, not against any live system** (see the honest
caveat below): a mailer `failed` result is never recorded as sent (no phantom sends / billing);
mailbox credentials persist AES-256-GCM-encrypted in the DB (survive restart, no silent mock
fallback); the standalone worker builds the SAME full `AppContext` as the API (env-gated real
sources/senders/poller — `packages/api/src/worker.ts`); the transactional ESP is env-wired
(Resend/Postmark); reply ingestion can't false-suppress (quoted-reply extraction never falls back
to raw, tenant-scoped, Message-Id dedup, STOP honored, OOO snooze); daily-cap/warmup/auto-pause are
enforced on the CAMPAIGN's mailbox; the unsubscribe link is HMAC-signed + confirm-on-GET; the
circuit breaker uses a rolling window and separates unsubscribes from complaints; discovery is
honest (no synthetic SERP in prod, bare `amzn.to` detected, exact-merchant-id backlink filter, no
identity over-merge); OAuth rails reach SMTP parity (raw-MIME headers + bounce mapping). New
capabilities: **bulk import** (prospects + affiliate roster — also guards a merchant's own
affiliates from cold email), **IG/TikTok discovery** (`SocialCreatorDiscoverySource` + social SERP
fallback), **content-freshness** (`activityRecency`), **merchant `bookingUrl`** (honest A-tier
calendar, no fabricated stub URL), and an **audience-quality flag** (bought-audience reach discount).

> ### ⚠️ HONEST CAVEAT — remediated ≠ go-live validated (do not overclaim)
> The audit fixed **logic and failure modes**, all tested **offline against mocks/stubs**. **NO
> provider key has ever run.** It is NOT yet validated to work against real systems, and must not
> be described as "safe to point at real prospects" until a keyed validation pass is done. Still
> untested end-to-end: real DataForSEO/SERP/YouTube/Hunter/scrape/proxy behavior (mocks return
> clean shapes; live APIs return rate limits, bans, odd/empty payloads); real SMTP send + IMAP
> reply poll + Microsoft/Google OAuth consent + token refresh (never touched a real account); ESP
> delivery (no welcome/magic-link email actually delivered); deliverability/warmup/bounce against a
> real inbox provider; the Postgres path (DDL exists, unrun). The optional deps aren't even
> installed — **`npm install nodemailer imapflow mailparser` (+ playwright)** — so real SMTP/IMAP/
> headless-fetch are inert until then. What IS true: the "unsafe-by-construction" bugs are gone.
> What is NOT: production validation. See **Tier 0 — go-live validation** in Next steps.

The **`docs/OUTREACH-SPEC.md` §16 queue is COMPLETE** — all seven items shipped: IMAP reply
poller (SMTP-rail inbound, PEEK-only, wired into the scheduler), activation welcome email
(magic link + tracking link + referral code + fast-start, idempotent), **AI-SDR** (topic-gate +
KB-in-context grounded answers + handoff packet + `Notifier` port, HITL/autopilot), per-client
**deliverability monitor** (per-mailbox bounce auto-pause + scheduled warmup), **pre-send content
gate** (`scanContent` blocks spam before send), **DM as a sequence step** (`channel:"dm"` →
prepared `DmTask`, never auto-DM), and the **web Outreach dashboards** (Handoffs, DM Queue,
Deliverability, Activation). Remaining is the deferred "act-on-it" tail in §16 (autopilot physical
auto-send needs the outbound-reply transport; OAuth consent + IMAP live validation need real keys;
calendar + payout rails; branching sequences).

The **email-outreach build** (spec: `docs/OUTREACH-SPEC.md`) — the engine can now SEND,
PERSONALIZE, and PROCESS REPLIES as the merchant:
- **Send-as-the-merchant**: `SmtpSender` (real SMTP AUTH, the launch rail — cPanel/host +
  Gmail app-password; Outlook/M365 need Graph OAuth, basic-auth SMTP retired), `buildMailboxSender`
  + per-send `mailboxResolver` loading encrypted creds from the SecretStore. `GmailSender`/
  `MicrosoftGraphSender` are real-shaped (OAuth flow itself = a later rung).
- **Smart Connect**: `detectMailProvider` MX-routes a merchant's email → easiest method
  (Google→app-password, Microsoft→OAuth, else pre-filled SMTP); web Integrations page wired.
- **Personalization**: per-merchant plan `template|hybrid|llm` (billed; metered as usageEvents),
  LLM body cites real evidence; `previewOutreach`. Cheap-LLM (Grok/Haiku) via the relevance wiring.
- **Replies + conversion**: `processInboundReply` (match sender→prospect→two-track route),
  `convertProspectToAffiliate` (idempotent prospect→Affiliate+Relationship so a recruit can
  magic-link into the portal), `applyToJoin` (public inbound self-serve, `POST /join/:merchantId`).
- **Deliverability (competitive-gap pass)**: one-click `List-Unsubscribe` (RFC 8058) header +
  POST endpoint; DKIM selector verification + From-alignment; cadence cap (1 initial + 3
  follow-ups); send-time/timezone gate (`isGoodLocalSendTime`); A/B step variants (`pickVariant`
  + `abResults`); seed-send placement test.
- **Activation analytics**: `activationMetrics` — activated/producing rates, time-to-first-sale,
  fast-start (the recruitment-ROI metric), from clicks+conversions joined via relationship `prospectId`.
- **Multichannel DM-assist** (compliant, semi-assisted — NEVER auto-DM): `bestDmTarget` +
  `dmDeepLink` (ig.me/m, t.me, profile links) + `draftDm`; `dm-queue` / `dm-draft` / `dm-sent` routes.

Pre-outreach, a large **discovery/enrichment-quality pass** also landed (all behind ports,
key-gated, offline-testable):
- **Fetcher hardening** (`integrations/http.ts`): `CachingFetcher` (short-TTL + in-flight
  coalescing — kills the resolver/frontier/enrich re-fetch) + `RateLimitedFetcher`
  (per-host throttle + global concurrency cap). Composed once in `context.ts`.
- **Free domain authority**: DataForSEO backlink rows already carry `domain_from_rank`
  (requested with `rank_scale:"one_hundred"`) → threaded `BacklinkRow → RawCandidate →
  prospectSignals.da`. The `quality` scoring factor was permanently null; now real for
  backlink-mined prospects at zero extra cost.
- **`audienceOverlap`** (`core/recruitment/audience-overlap.ts`): geo/language alignment
  from the real creator geo/language we already fetch vs a currency-derived target market;
  null when genuinely unknown.
- **Pluggable relevance** (`integrations/relevance.ts`): `RelevanceScorer` — lexical
  embedder offline, a CHEAP LLM when keyed. `RELEVANCE_LLM_*` env points it at any
  OpenAI-compatible budget model (Grok/Groq/OpenAI-mini/DeepSeek via `OpenAiCompatibleLlmClient`),
  else Haiku. Replaces hash-similarity relevance with semantic niche fit.
- **New discovery sources**: `YouTubeDiscoverySource` (search.list → channels, free API,
  reaches website-less video creators), `PodcastDiscoverySource` (free iTunes API + RSS
  feed → owner email + site, contactable), `DataForSEOSerpProvider` (Google-organic-live,
  ~$0.002/q — real SERP reusing the DataForSEO key, no SerpApi needed). SERP-budget fix
  (`query-strategy.ts` + `SerpDiscoverySource`) reserves room so platform-targeted
  creator queries aren't starved by competitor queries.
- **Cross-platform prospect merge** (`core/profile/identity-merge.ts` + `ingestCandidate`):
  a creator found as a YouTube channel + a website + a social collapses into ONE prospect
  when they share a hard identifier (handle / email / website domain). `mergeProfiles` unions
  the graph.
- **Triage + guards** (`core/recruitment/triage.ts`, `recruitment/guards.ts`, `service.ts`):
  `preScoreProspect` ranks on cheap discovery-time signals → `runSourcing` enriches
  best-first, tiers PAID enrichment depth by band, and `maxEnrich`-defers the cold tail;
  guards skip enriching/cold-emailing existing affiliates (`isExistingAffiliate`) and
  suppressed contacts. (Contact-finding fetches are NOT tiered down — they're what make a
  prospect contactable.)
- **Graph-traversal contact resolver** (`recruitment/contact-resolver.ts`): best-effort
  email finding as a bounded BFS over the identity graph that EXPANDS as it goes (social
  bio → website → `/contact` → email); converges from any entry point. YouTube uses the
  free channel-description email/website (`enrichers.ts` parses `snippet.description`,
  surfaced on `AccountMetrics.emails/links`) — the captcha-gated About page is bypassed.
  Replaces the old fixed waterfall in `enrich`.

Earlier this session (also committed): DataForSEO `one_per_domain` + apex affiliate-marker
filter; `ingestCandidate` extracted + shared; homepage-fetch-in-enrich; headless-browser
fetching (`PlaywrightFetcher`/`EscalatingFetcher`/`looksBlocked`, env `BROWSER_FETCH`).

## Next steps (priority tiers — what to work on)

Discovery→enrich→score AND the outreach recruit→close half now exist end-to-end in code
(and the §16 queue + the 2026-07 audit are done). The dominant remaining blocker is **not
more building — it is validating the built system against real keys/services.** Order:

**Tier 0 — GO-LIVE VALIDATION (the real blocker; needs keys + a box, not more code).**
Nothing below the code layer has been exercised against a live system. Do this before pointing
the engine at any real prospect list:
1. `npm install nodemailer imapflow mailparser` (+ `playwright && npx playwright install chromium`
   if scraping JS-rendered pages) — these OPTIONAL deps are what make real SMTP send / IMAP reply
   poll / headless fetch actually run. Until installed they're inert.
2. Prod hardening on the box: `JWT_SECRET`, `SECRETS_ENC_KEY`, `NODE_ENV=production`,
   `ALLOW_SYNTHETIC_DISCOVERY=false`, `USE_POSTGRES`/`DATABASE_URL`, `PUBLIC_API_URL`,
   `CORS_ORIGINS`. Deploy per `DEPLOYMENT.md` (VPS/Hetzner origin + Cloudflare edge; the 3
   Hetzner rules: never email from box IP, scrape via proxies, back ledger off-box).
3. Connect ONE real mailbox; run the SMTP send + IMAP reply round-trip end-to-end (email a test
   address, reply, watch `ingestReplies`/`processInboundReply` route + stop the sequence).
4. Run the Microsoft/Google OAuth consent round-trip once; confirm token refresh + a real send.
5. Wire an ESP key (Resend/Postmark); confirm a welcome/magic-link email actually delivers.
6. Small keyed discovery run (`DATAFORSEO_LOGIN/PASSWORD`, `SERPAPI_KEY`/`YOUTUBE_API_KEY`,
   `HUNTER_API_KEY`, `SCRAPE_API_URL`, `PROXY_URL`) — eyeball that outputs are real + honestly
   labeled, and that live payloads (rate limits, bans, empties) are handled.
7. Warm a mailbox properly before ANY volume; watch bounce/complaint on the Deliverability
   dashboard. Run the seed/placement test.
(Everything above is logic-tested with mocks only — the mock returns clean shapes; the real world
does not. This is the honesty gap, not a nice-to-have.)

**Tier 1 — remaining act-on-it stubs (real building):**
- **Branching/conditional sequences**: the model (step `channel`, `variants`) is in and email→DM
  steps auto-advance; open/click-triggered branching is the next rung.
- **Calendar booking adapter** (Cal.com / Google) — `bookingUrl` (merchant-pasted link) ships;
  a per-prospect tracked adapter (`CalcomBooking`) is still a skeleton.
- **Payout rails** (Stripe Connect / PayPal / Wise) — stubs.
- **SES dedicated-domain rail** + DNS automation (scale/deliverability) — OUTREACH-SPEC Phase 2.
- **Autopilot physical auto-send** of AI-SDR answers now has its transport (`sendReplyToProspect`);
  wiring `autoSend:true` to actually fire it (vs the HITL handoff) is a small follow-up.
- **Campaign PATCH** currently accepts only `sequence/status/dailyCap` (send-window/mailbox are
  edit-on-create); widen the schema if the editor needs them. Podcast RSS `pubDate` freshness
  (YouTube date is captured; podcast isn't yet).

**Tier 2 — discovery polish / levers (optional iteration):**
- **Per-merchant ICP override UI** for competitor program IDs + an explicit target-market
  field (audienceOverlap currently derives it from billing currency).
- **DataForSEO Labs niche graph** (`competitors_domain`/`serp_competitors`) to feed the
  recursive frontier / Niche Map (research done: cheaper + better-structured than raw SERP).
- **LLM query expansion** (cheap — the LLM client exists).
- **DataForSEO SERP queued mode** (standard queue $0.0006 vs live $0.002) — only worth it
  at volume; needs the async POST/poll path. Latency hides inside the scraping-bound run.
- **Demo-mode frontier growth** + Niche Map node animations.
- **Managed-unblocker rung** for CAPTCHA-hard targets (optional, behind the fetcher port).
- **Postgres integration tests**, CF KV/Queue wiring, datacenter-IP detection — see
  REMEDIATION.md "still open".
