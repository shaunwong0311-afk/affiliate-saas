# Autonomous Recruitment Engine

The wedge: helping merchants **find quality affiliates from scratch** with as little
human work as the system allows. A merchant connects a store + mailbox and gives a
niche + competitors; the engine sources the open web, enriches, scores for
*will-produce-sales*, sends as the merchant, sequences, and routes replies — with
humans kept only where judgment changes the outcome.

## Operating model — "L4 with two HITL gates"

Full autonomy is **not** the goal (it burns domains and recruits non-producers).
The target is high automation with two deliberate human gates, mapped to the fact
that revenue is hyper-concentrated (~80% from the top ~5% of partners):

```
ICP ─▶ SOURCE ─▶ ENRICH ─▶ SCORE ─▶ ┬─ auto-send (B/C, score ≥ threshold)         ─▶ SEQUENCE ─▶ REPLY ─┬─ long-tail  → AI-SDR answer + self-serve signup
        (open web)                  └─ HITL gate (A-tier / borderline → human OK)                       └─ A-tier     → AI-SDR qualify → BOOK MEETING → owner
                                                                                                                          (human closes, negotiated terms)
        ▲                                                                                                                              │
        └──────────────── closed loop: producer outcomes retrain scoring & prune low-yield sources ◀──────────────────────────────────┘
```

The operator's job becomes **approve-and-monitor**, not find-and-write.

## The six stages (code map)

| Stage | What it does | Where |
|---|---|---|
| **1. Source** | SERP mining (buyer-intent queries → result pages → affiliate-link detection), competitor-affiliate (backlink) mining, YouTube / podcast / social creator discovery. First-party customer mining exists but the planner always skips it: customers carry hashed emails only, so there is no contact path. | `integrations/discovery-real.ts`, `discovery.ts`, `core/recruitment/affiliate-detection.ts` |
| **2. Enrich** | contact resolution over pages the creator owns, verification, reach/engagement/DA signals; records a usage event. No published address and no Hunter key = no contact (never a guess). | `recruitment/pipeline.ts` `enrich()`, `integrations/enrichment.ts` |
| **3. Score** | fit + propensity, weights **blended toward this merchant's producer outcomes** | `pipeline.ts` `score()` + `learning.ts` `weightsForMerchant()` |
| **4. Outreach** | send-as-merchant, tiered personalization, multi-step cadence (initial → follow-up → breakup) with send windows, per-mailbox caps, hard stops | `pipeline.ts`, `automation.ts` `advanceSequences()`, `sequencing.ts` |
| **5. Reply** | ingest (IMAP / Graph poll, or the inbound webhook) → correlate by thread → classify (LLM when configured, else keyword) → two-track router; delivery-status mail marks bounces | `reply-router.ts`, `integrations/reply-ingestion.ts` |
| **6. Closed loop** | append-only `ProspectOutcome` → source-yield pruning + learned scoring | `learning.ts`, `service.ts` `recordOutcome()` |

The scheduler (`worker.ts` `runScheduler`/`tickScheduler`) runs `autonomousCycle`
per merchant whose automation is `running`; one merchant's failure is logged and does not
stop the others, and replies are ingested every tick regardless. Run it in-process with
`SCHEDULER=true npm run api` (dev), or as the standalone worker (`npm run worker`) against
the same Postgres database as the API — one or the other, never both.

**Cadence.** Sends, follow-ups and reply ingestion run every tick (default 60 s). **Sourcing
runs on its own interval** — `AutomationState.sourcingIntervalHours`, default 24 — so
discovery queries are not re-issued every minute. A manual "Run cycle" forces sourcing.
Every path that queues or sends holds a per-merchant lock, so a tick, a manual run and a
campaign launch cannot double-send.

## What requires a human vs. what's autonomous

| Autonomous | Human gate (deliberate) |
|---|---|
| Sourcing, enrichment, scoring, tiering | **A-tier (or below `hitlTier`) outreach approval** — held in the review queue |
| Auto-send for B/C ≥ `autoSendMinScore` | **Warm A-tier replies** — the AI-SDR opens a handoff with the merchant's booking link; a human books and closes |
| Multi-step follow-ups, send-window/cap enforcement | (everything else runs unattended) |
| Long-tail interested replies → a handoff with a ready-to-send signup link; in autopilot, deterministic knowledge-base answers are sent automatically | |
| Suppression, geo-gating, circuit breaker | |

Tunable per merchant via `AutomationState` (`autoSendMinScore`, `hitlTier`,
`meetingTier`, `sourcingLimitPerCycle`) on the **Automation** dashboard page.

## External services — config-or-fallback, the "see how" answer

Every web-touching capability is a **port** with a deterministic local fallback
(default — runs offline, tests pass) and a real adapter skeleton wired for
production. The proxy/SERP/etc. decision is a config swap behind the port, never a
rewrite:

| Capability | Port | Default (offline) | Real adapter | Live-validated? |
|---|---|---|---|---|
| Scrape HTTP | `HttpFetcher` | `DeterministicFetcher` | `ProxyHttpFetcher` (`undici` proxy pool, SSRF guard, timeouts) → `PlaywrightFetcher` when a page looks blocked | proxy path tested locally; no real proxy vendor |
| SERP | `SerpProvider` | `DeterministicSerpProvider` (demo only) | `SerpApiProvider`, `DataForSEOSerpProvider` | no |
| Backlinks | `DiscoverySource` | (none) | `BacklinkDiscoverySource` + `DataForSEOBacklinkProvider` | no |
| Creator discovery | `DiscoverySource` | synthetic generators (demo only) | `YouTubeDiscoverySource`, `PodcastDiscoverySource`, `SocialCreatorDiscoverySource` | no |
| Email find/verify | `EmailFinder` / `EmailVerifier` | `StubEmailFinder` (demo prospects only) | `HunterFinder`, `MxEmailVerifier` | no |
| Send mailbox | `MailboxSender` | `MockMailboxSender` (never in production) | `SmtpSender` (launch rail), `MicrosoftGraphSender`, `GmailSender` | SMTP against a local catcher only |
| Reply ingest | reply poller | inbound webhook | `ImapReplyIngestion` (SMTP mailboxes), `GraphReplyIngestion` (Microsoft). Gmail-via-Google: none yet → follow-ups hold | no |
| Transactional mail | `TransactionalMailer` | console (refuses to report "sent" in production) | `ResendMailer`, `PostmarkMailer` | no |
| LLM | `LlmClient` | `DeterministicLlm` | `AnthropicLlmClient` (`claude-opus-4-8`), `OpenAiCompatibleLlmClient` | no |
| Meeting booking | `CalendarBooking` | `StubCalendarBooking` | merchant-pasted `bookingUrl` (used verbatim); Cal.com is a skeleton | n/a |

## Deliverability & compliance (woven in)

- **Warmup** ramp + per-mailbox **daily cap** (a rolling 24 hours), enforced on the campaign's
  own mailbox (`deliverability.ts`). There is no mailbox rotation.
- **Bounces.** Only recipient-level permanent failures count. Sender-side, policy, quota and
  auth rejections are `failed`: nobody is suppressed, and repeated failures back the mailbox
  off. Delivery-status notifications that arrive later are parsed and recorded as bounces.
- **Circuit breaker**: pauses sending when the bounce rate over a rolling window passes 2%.
  There is **no complaint feed**, so complaint figures read "not available" — the 0.3%
  complaint threshold is not enforceable until one exists.
- **Reply visibility.** A mailbox whose replies cannot be read sends first touches only;
  follow-ups hold until the inbox can be read.
- **CAN-SPAM**: sending is blocked until the merchant has a postal address on file; every
  send carries it plus `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058).
- **Unsubscribe**: a signed link; GET shows a confirm page, POST suppresses. Form posts and
  one-click posts both work. A STOP reply to mail we actually sent does the same.
- **Suppression scope**: unsubscribes and STOP replies to delivered mail apply platform-wide;
  anything a merchant enters by hand applies to that merchant only; hard bounces are
  merchant-scoped.
- **GDPR/CASL**: EU + Canada cold outreach is blocked when the prospect's country is known.
  An unknown country is not blocked — only YouTube and scrape enrichment set it today.
- **Send time**: the campaign's time zone and, when the country is known, the recipient's
  local time.
- **Demo data** never leaves through a real mailbox.

## The metric that matters

`producingFunnel` (`/reports/producing-funnel`) goes past signup to **cost per
*producing* affiliate**: sourced → recruited → producing, **% producing**,
**time-to-first-sale**, and **revenue by source cohort** — computable because
recruited relationships now carry a `prospectId`/`source`, so a producing
affiliate is traceable to the source that found it. `sourceYield` drives automatic
pruning of low-yield sources.

## Try it

```bash
npm run demo   # seeds a tenant, runs an autonomous cycle, prints the producing funnel + source yield
SEED_DEMO=true SCHEDULER=true npm run api   # live engine; Automation page in the web app
```

> The cross-merchant network/lookalike source (recruit producers proven on *other*
> merchants) is intentionally **not** built here — it raises a client-competition /
> data-provenance question that needs a deliberate product decision (lookalike-first,
> opt-in marketplace, producer protection). See the conversation notes.

---

## Discovery internals — current (2026 update)

The discovery half of stage 1 became the most built-out part of the system. It now
runs end-to-end behind ports and lights up with real data when provider keys are set
(see `CLAUDE.md` → Provider keys). Components:

- **Query strategy** (`integrations/query-strategy.ts`) — `buildDiscoveryQueries`
  turns the ICP into a prioritized, deduped, capped SERP query set: competitor-affiliate
  mining first, then buyer-intent, then merchant keywords, then **platform-targeted**
  queries (`site:youtube.com`, `site:substack.com`, podcasts…) that reach the walled
  platforms via SERP. `SerpDiscoverySource` does **platform-aware dedup** (two
  `youtube.com/@x` creators don't collapse to one host) and sets `channelUrl` for social hits.

- **Discovery planner** (`recruitment/discovery-planner.ts`) — `planDiscovery` is the
  "what to do" brain: inspects the merchant (competitors set? orders on file?) + the
  available sources and emits a **prioritized plan** (warmest first), **skipping**
  inapplicable sources with a reason. `runSourcing` plans first, runs in that order, and
  returns the plan in its summary (shown in `npm run demo` as "DISCOVERY PLAN").

- **Affiliate-network registry** (`core/profile/affiliate-networks.ts`) — ~15 networks.
  `identifyProgram(url)` → `{network, merchantId | vanityHost}`; `backlinkTargetsFor` →
  the precise backlink query (vanity host directly, or network domain filtered by
  merchant id);
  `merchantDomainFromLink` → resolves shared-network links to the brand domain via the
  destination param (`urllink`/`murl`/`ued`); `competitorHostsFromLinks` → the OTHER
  merchants an affiliate promotes (the recursive signal).

- **Competitor-affiliate mining done right** (`BacklinkDiscoverySource` +
  `CompetitorProgramResolver` + `DataForSEOBacklinkProvider`). The resolver reads the
  competitor's own site to find their network + merchant id (or vanity domain); mining
  queries the right backlinks and keeps only links carrying an affiliate signature
  toward the competitor; network-targeted hits set `RawCandidate.confirmedCompetitor`
  so the pipeline trusts the competitor-promotion signal even for network-domain links.

- **Identity graph** (`core/profile/identity.ts`) — unifies a creator across platforms
  from the links they published (provenance + confidence); on `Prospect.evidence.profile`.

- **Audience enrichers** (`integrations/enrichers.ts`, `AccountEnricher`/`EnricherRegistry`/
  `CachingEnricher`) — fill real `reach`/`engagement`: `YouTubeEnricher` (free),
  `ScrapeMetricsEnricher` (IG/TikTok/X), `OnPageSubscriberEnricher` (Substack). Cached
  per creator; unknown stays null.

- **Recursive frontier** (`recruitment/frontier.ts` `expandFrontier`) — the snowball:
  competitor → mine affiliates → read their other affiliate links → promote the
  frequently co-promoted merchants as new seeds → repeat. Persisted in `frontierMerchants`
  (visited set); HARD-CAPPED per cycle (seeds/expansions/new-seeds/depth/min-co-promotions);
  wired into `autonomousCycle`. Surfaced as the **Niche Map** (`web/pages/NicheMap.tsx`,
  route `/niche-map`) — an interactive radial graph (pan/zoom/hover/click); API
  `GET /recruitment/frontier`, `POST /recruitment/frontier/expand`.

**Honesty rule (REMEDIATION.md):** evidence-backed real data OR labeled demo — never
fabricate. A real prospect never receives a guessed address; a contact is taken only from a
page the creator demonstrably owns; a demo prospect is never emailed through a real mailbox. `synthetic` flag on every prospect; provider signals null when unwired;
no invented links on failed fetch. In demo mode the Niche Map seeds + mines but won't
snowball (expansion needs a real fetcher/backlink key for co-promotion data).

## DataForSEO cost strategy (backlink mining)

DataForSEO charges $0.02/request + $0.00003/row (≤1000 rows/request → $0.05/1k). A
domain can have 100k+ backlinks but only a few-k REFERRING DOMAINS, and for affiliate
finding **one affiliate = one referring domain**. So `DataForSEOBacklinkProvider` uses
**`mode: "one_per_domain"`** (one representative backlink per referring domain), caps
`limit` at 1000 (one request ≈ $0.05/competitor for the top referring domains), and
orders by rank. It does NOT filter `dofollow=true` — affiliate links are usually
rel=sponsored/nofollow. Network-targeted queries (network domain + merchant-id filter)
are inherently one-affiliate-per-domain. The frontier widens by adding more competitors
rather than paging deeper into one.

## Future adjacencies (parked — NOT the wedge)

The same DataForSEO subscription that powers competitor-affiliate mining could power
light merchant-facing **competitive-intel value-adds** inside the product: a
competitor's backlink/affiliate footprint, content gaps where affiliates could rank,
"who links to them that doesn't link to you." Surfer-style content optimization is
very feasible on DataForSEO's SERP + on-page APIs (the moat is the scoring/UX, not the
data). An Ahrefs-style backlink explorer is buildable as a *product* but can't match
Ahrefs' proprietary index depth (~2.8T DataForSEO vs ~35T Ahrefs). Treat all of this as
a future upsell riding infra we already pay for — **an adjacency, not a pivot.** Don't
let "build our own Ahrefs" dilute the recruitment wedge.

## Enrichment + fetching internals (current)

- **enrich** (`pipeline.ts`) — homepage-first: when a source gave no page HTML (backlink
  mining gives only the domain + competitor link), enrich **fetches the prospect's
  homepage** so the extractors light up — real on-page email (extract → MX verify),
  identity graph (their other platforms → enrichers fill reach/engagement), contact
  URLs/form, and their full affiliate-link profile (which the frontier reads). Then it
  follows the discovered contact URLs (Linktree/`/contact`/YT-About) as a second pass,
  and falls back to the EmailFinder (Hunter by domain) only if nothing's found. All
  page parsing/detection is OUR code (`web-evidence.ts` + `core/profile`), regex/
  heuristics — no scraping SaaS.
- **Fetching ladder** (`HttpFetcher` port): cheap static fetch (`ProxyHttpFetcher`, UA +
  proxy rotation; with `PROXY_URL` set a fetch that cannot use the proxy fails rather than
  going direct; every fetch goes through `net-guard.ts`, which refuses internal addresses
  and re-checks each redirect hop) → **headless browser** (`PlaywrightFetcher`, env
  `BROWSER_FETCH`, optional `npm install playwright`) which `EscalatingFetcher` triggers
  ONLY when a page looks blocked/empty/challenged (`looksBlocked`). The browser passes
  JS anti-bot challenges (Cloudflare "checking your browser"); CAPTCHA walls are NOT
  solved here — they need residential proxies to avoid, or a managed-unblocker API as
  an optional next rung behind the same port. Static-HTML-only otherwise (no JS exec)
  unless `BROWSER_FETCH` is on. A true block → honest miss (no fabricated data).

## Discovery/enrichment quality pass (current)

A round of work focused on COVERAGE, SIGNAL QUALITY, EFFICIENCY, and CONTACTABILITY —
all behind ports, key-gated, offline-testable:

- **Fetcher hardening** (`integrations/http.ts`): `CachingFetcher` (short-TTL + in-flight
  coalescing, so the program resolver / frontier / enrich never re-fetch the same page)
  and `RateLimitedFetcher` (per-host min-interval reserved up front + global concurrency
  cap). Composed once in `context.ts`: `Caching(RateLimited(Escalating(proxy, playwright)))`.
- **Free domain authority**: the DataForSEO backlinks response carries the referring
  domain's rank on every row. We add `rank_scale:"one_hundred"` and read `domain_from_rank`
  (0..100) → `RawCandidate.domainAuthority` → `prospectSignals.da`. No extra call. The
  `quality` scoring factor (previously always null for everyone) is now real for
  backlink-mined prospects.
- **Audience overlap** (`core/recruitment/audience-overlap.ts`): `audienceOverlapScore`
  from the real creator geo/language (YouTube `country`/`defaultLanguage`, scrape country)
  vs `targetMarketForCurrency(merchant.defaultCurrency)`. Both-unknown → null (never invented).
- **Relevance** (`integrations/relevance.ts`): `RelevanceScorer` — `EmbeddingRelevanceScorer`
  (lexical, offline) or `LlmRelevanceScorer` (semantic). Wired in `context.ts` with
  precedence `RELEVANCE_LLM_API_KEY` (any OpenAI-compatible budget model via
  `OpenAiCompatibleLlmClient`; defaults to xAI Grok-fast) → `ANTHROPIC_API_KEY` (Haiku) →
  embedder. ~$0.0001–0.001/prospect, cached. Replaces hash-similarity in `score`.
- **New sources**: `YouTubeDiscoverySource` (search.list, free, reaches website-less
  creators), `PodcastDiscoverySource` (`integrations/discovery-podcast.ts` — free iTunes
  Search API + RSS feed → owner email + website, so podcasts are contactable),
  `DataForSEOSerpProvider` (Google-organic-live ~$0.002/q, real SERP reusing the
  DataForSEO key). All labeled in the discovery planner. SERP-budget guard
  (`query-strategy.ts` reserves ~35% for platform channels + `SerpDiscoverySource` caps
  primary queries) so YouTube/Substack/Reddit creator queries aren't starved.
- **Cross-platform prospect merge** (`core/profile/identity-merge.ts`): `ingestCandidate`
  computes `identitySignalsFromProfile` (owned account keys / own-domain emails / website
  domains) and, when they match an existing prospect in the per-run identity index, MERGES (`mergeProfiles` + union links/
  contacts, fill missing URLs, OR signals) and returns null instead of inserting a dup.
  One creator across YouTube + website + socials = one comprehensive prospect.
- **Triage + guards** (`core/recruitment/triage.ts`, `recruitment/guards.ts`,
  `service.ts`): `preScoreProspect` (cheap pre-score: competitor-promotion, affiliate,
  free DA, intent, contact-path) → `runSourcing` enriches best-first, tiers the PAID
  enrichment depth (`enrich({ maxAccounts })`) by band, and `maxEnrich`-defers the cold
  tail. Guards skip enriching/cold-emailing existing affiliates (`isExistingAffiliate`,
  by relationship `prospectId` or affiliate email) and suppressed contacts. NOTE:
  contact-finding fetches are NOT tiered down — only paid audience lookups scale, because
  the contact fetch is what makes a prospect reachable in the first place.
- **Graph-traversal contact resolver** (`recruitment/contact-resolver.ts`):
  `resolveContact` is a bounded best-effort BFS over the identity graph. Tries on-page
  emails first, then walks every linked property (bio aggregator → contact page →
  website → YouTube API → social), EXPANDING as it discovers new nodes (a social bio
  links the website; the website's `/contact` has the email). Converges from ANY entry
  point; stops at the first MX-verified address. YouTube uses the free channel
  DESCRIPTION (`enrichers.ts` parses `snippet.description` → `AccountMetrics.emails/links`)
  to bypass the captcha-gated About page. Replaces the fixed waterfall in `enrich`; Hunter
  stays the final fallback. Email acquisition is now strong across backlink/SERP/podcast/
  YouTube (customer mining is contact-less by design — hashed email).

## Changed in October 2026 (see `docs/AUDIT-2026-10.md`)

Where this file's older sections disagree with the list below, the list is right.

- **Contacts.** The resolver accepts an address only from a page the creator owns (their own
  site, or an account with seed / bio-aggregator / reciprocal provenance). Outbound links are
  not followed for contacts; addresses at a competitor's or the merchant's own domain are
  rejected; the podcast feed's owner email is used first. The pattern-guessing finder runs
  for demo prospects only.
- **Ingest exclusions.** The competitor's own domains, the merchant's own domains (from
  connected mailboxes and sending domains), marketplaces and social hosts are not prospects.
- **Identity merge.** Owned handles and own-domain emails only; a shared third-party address
  or a handle-less platform URL no longer merges two creators.
- **Scoring.** A new nullable `activity` factor (weight 0.05); engagement is mapped on a
  scale (1% → 0.5, 3% → 0.85, ≥5% → 1) instead of used raw; unknown relevance, DA and
  engagement stay null and are reported in `unknownFactors`. A prospect whose relevance is
  unknown stays `enriched` and is scored on the next run.
- **Pruning.** A source is dropped only when at least 20 of its prospects were contacted 30+
  days ago and under 2% produced — and never the last usable source.
- **Frontier.** A host is promoted to a seed only when the network registry identifies it or
  a HIGH-confidence signal points at it; generic `ref=` / `via=` / `/go/` never promotes.
- **Query plan.** The reserved platform slots rotate, so podcast, Reddit, Instagram and
  TikTok queries run as well as YouTube and newsletters.
- **Provider errors** are surfaced (`SourcingSummary.sourceErrors`) instead of looking like
  "no results"; failures are not cached as misses.
- **Removed as dead code:** `parseProgramInput`, manual competitor-program overrides,
  `knownNetworks`, `learnedWeights`, `identitiesOverlap`.
- **Still unverified against live providers:** the scrape actor's request contract, Hunter's
  email-finder (it wants a person's name), DataForSEO's nested filter form and US/en SERP
  locale, YouTube quota behaviour, CJ path-style links, Playwright with proxy credentials.
