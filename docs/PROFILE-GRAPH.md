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

- **Audience demographics: infer free now, buy later.** Cheap proxies first (creator geo, content language, engagement estimate); a paid `AudienceProvider` can drop in later for A-tier prospects only. The seam (`AudienceProvider` port) is already defined.
- **Platforms prioritized:** YouTube + blogs/SEO, X/Twitter, newsletters + podcasts. Instagram/TikTok are recognized as graph nodes but we don't build collectors for them (scrape-hostile; would need paid/official APIs).
- **Build order:** identity-graph foundation first (Phases 0–1), then the YouTube enricher.

## Architecture (four layers)

1. **Collectors** (`ProfileSource` port) — one adapter per platform; given a seed returns a profile fragment + cross-links + cheap audience signals. Deterministic stubs offline; real adapters key-gated (same pattern as SERP/Hunter).
2. **Identity resolution → the graph** (`packages/core/src/profile/identity.ts`, pure) — classify links into `Account`s and unify them. Provenance, in trust order: `seed` (1.0) → `reciprocal_link` (0.95) → `bio_aggregator` (0.9) → `shared_domain` (0.8) → `page_link` (0.5). Nothing merges on a guess.
3. **Enrichment** (`AudienceProvider` port) — fill per-account metrics, each tagged with source + confidence; `null` when no provider.
4. **Fit scoring** — extend the existing scorer with audience overlap, aggregated reach, brand-safety; keep confidence-weighting; close the loop with outcomes.

## Status

- **Phase 0 — model & contracts** ✅ `Account` / `Profile` / `AudienceEstimate` types + pure resolution (`classifyAccountUrl`, `seedAccount`, `buildProfile`, `addPageToProfile`); `ProfileSource` + `AudienceProvider` port contracts; `extractHrefs`. Persisted on `Prospect.evidence.profile`.
- **Phase 1 — identity from links we already fetch** ✅ `discover` builds the seed + primary-page accounts; `enrich` grows the graph from bio-aggregator/contact pages it fetches (double duty with email extraction). Bio-aggregator listings are high-confidence; one-directional page links are low. Surfaced in the Recruitment review UI ("Identity graph").
- **Phase 2 — YouTube Data API enricher** ⏳ `channels.list?forHandle` (1 unit) → `subscriberCount`→reach, `country`→geo, `description`→email/links. The gated "business email" is **not** in the API (CAPTCHA-gated) — we mine the description + linked surfaces instead. Key-gated `YOUTUBE_API_KEY`.
- **Phase 3 — inferred audience** ⏳ content language, creator geo, engagement estimate, optional commenter-language sampling — all confidence-scored, behind `AudienceProvider`.
- **Phase 4 — paid audience provider** ⏳ optional Modash/HypeAuditor adapter for A-tier only (cost control).
- **Phase 5 — fit-scoring upgrade** ⏳ audience overlap (merchant customer geo/lang vs creator audience), multi-platform reach, brand-safety, closed loop.

## How it maps to the code

- `Prospect` generalizes toward a `Profile` owning multiple `Account`s. For now the resolved graph lives on `Prospect.evidence.profile` (lightweight); a dedicated `profiles`/`accounts`/`edges` store is a later option if the graph needs to be queried independently.
- Ports: `ProfileSource` (collector) and `AudienceProvider` (paid/inferred), both with deterministic stubs + key-gated real adapters.
