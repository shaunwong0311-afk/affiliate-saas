# Creator profile graph — plan & design

The recruitment engine's job is to decide **who is a good fit for a merchant's affiliate
program**. To do that well we need to know, for each prospect:

1. **Who they are** — every surface one creator owns (YouTube, blog, X, newsletter, podcast). → *identity resolution*.
2. **Where they come from** — home platform, niche, content language, their own geography, how they already monetize (which networks/competitors they promote — already detected).
3. **Where their audience is** — size per platform, audience geography/language, demographics, engagement quality.

Only after 1–3 can fit + propensity be scored honestly.

## The hard truth about data availability

| Signal | Source | Cost |
|---|---|---|
| Cross-platform handles (graph edges) | bio aggregators (Linktree enumerates everything), reciprocal links | **free** — we already fetch these |
| Creator's own geo / language | YouTube `snippet.country`, content language | **free** |
| Reach (subs/followers) | YouTube `subscriberCount` (1 quota unit), public counts | **free / cheap** |
| Monetization & competitor promotion | outbound affiliate-link analysis | **free** — already built |
| Engagement *rate* | estimate from public likes/comments | **free, noisy** |
| **Audience geo / age / interests** | creator-intelligence APIs (Modash/HypeAuditor) **or** the creator's media kit | **paid or creator-provided** — *not* freely scrapable |

**Key constraint:** audience demographics are proprietary — only the creator sees their own analytics. We surface everything with provenance + confidence; unknown stays `null`, never invented (same discipline as scoring).

## Decisions (made)

- **Reach + engagement: cheapest source per platform, no premium needed.** These are *not* inherently paid — YouTube gives subscriber count **and** real engagement (likes+comments÷views on recent uploads) for free via the Data API; Substack prints subscriber counts on-page. Only the *walled* platforms cost: Instagram/TikTok/X public counts + engagement come from a **scraping-API actor** (Apify/ScrapingBee-style) — cheap, public numbers only.
- **Audience demographics (geo/age/interests): deferred.** Genuinely proprietary (paid creator-intelligence) — a later add, A-tier only, behind the same seam. Not built now.
- **Verticals: mixed / varies by merchant** → coverage must span platforms, so enrichment is provider-agnostic: one `AccountEnricher` registry routes each account to the right source.
- **One adapter per provider, not per platform.** We do NOT build bespoke scrapers for hostile platforms; a single scraping-API adapter covers IG/TikTok/X, and the identity graph already surfaces those handles from cross-platform links.

## Architecture (four layers)

1. **Collectors** (`ProfileSource` port) — one adapter per platform; given a seed returns a profile fragment + cross-links + cheap audience signals. Deterministic stubs offline; real adapters key-gated (same pattern as SERP/Hunter).
2. **Identity resolution → the graph** (`packages/core/src/profile/identity.ts`, pure) — classify links into `Account`s and unify them. Provenance, in trust order: `seed` (1.0) → `reciprocal_link` (0.95) → `bio_aggregator` (0.9) → `shared_domain` (0.8) → `page_link` (0.5). Nothing merges on a guess.
3. **Enrichment** (`AccountEnricher` port + `EnricherRegistry`) — route each account to the cheapest source for its platform (YouTube API / scrape-API / on-page) and fill reach + engagement, tagged with `source`; `null` when no enricher. Demographics are a future enricher (`source: "provider"`).
4. **Fit scoring** — extend the existing scorer with audience overlap, aggregated reach, brand-safety; keep confidence-weighting; close the loop with outcomes.

## Status

- **Phase 0 — model & contracts** ✅ `Account` / `Profile` / `AudienceEstimate` types + pure resolution (`classifyAccountUrl`, `seedAccount`, `buildProfile`, `addPageToProfile`); `ProfileSource` + `AudienceProvider` port contracts; `extractHrefs`. Persisted on `Prospect.evidence.profile`.
- **Phase 1 — identity from links we already fetch** ✅ `discover` builds the seed + primary-page accounts; `enrich` grows the graph from bio-aggregator/contact pages it fetches (double duty with email extraction). Bio-aggregator listings are high-confidence; one-directional page links are low. Surfaced in the Recruitment review UI ("Identity graph").
- **Phase 2 — per-platform reach + engagement enrichment** ✅ `AccountEnricher` + `EnricherRegistry`, wired into `enrich` over the graph's primary/high-confidence accounts; fills real `reach` + `engagement` signals (were null) and `profile.audience`. Adapters: `YouTubeEnricher` (free Data API — subs + real engagement from recent uploads + country), `ScrapeMetricsEnricher` (IG/TikTok/X public counts via a scraping-API actor, `SCRAPE_API_URL`-gated skeleton), `OnPageSubscriberEnricher` (Substack/beehiiv on-page count). All key-gated; unknown stays null. Surfaced on the UI identity card.
- **Phase 3 — inferred audience** ⏳ content language, commenter-language sampling, and (where no enricher exists) coarse geo proxies — confidence-scored, behind the same registry.
- **Phase 4 — paid audience demographics** ⏳ optional Modash/HypeAuditor adapter (`source: "provider"`) for A-tier only (cost control) — adds audience geo/age/interests.
- **Phase 5 — fit-scoring upgrade** ⏳ audience overlap (merchant customer geo/lang vs creator audience), multi-platform reach, brand-safety, closed loop.

**Live keys needed (cannot be exercised here):** `YOUTUBE_API_KEY` for real YouTube stats; `SCRAPE_API_URL`/`SCRAPE_API_KEY` for the IG/TikTok/X actor. Both are built to the documented shapes, unit-tested with mocked HTTP, and run via deterministic/empty paths offline.

## How it maps to the code

- `Prospect` generalizes toward a `Profile` owning multiple `Account`s. For now the resolved graph lives on `Prospect.evidence.profile` (lightweight); a dedicated `profiles`/`accounts`/`edges` store is a later option if the graph needs to be queried independently.
- Ports: `ProfileSource` (collector) and `AudienceProvider` (paid/inferred), both with deterministic stubs + key-gated real adapters.
