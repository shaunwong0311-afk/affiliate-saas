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
| **1. Source** | SERP mining (buyer-intent queries → result pages → affiliate-link detection), competitor-affiliate mining, creator discovery, first-party customer mining (reads real orders) | `integrations/discovery-real.ts`, `discovery.ts`, `core/recruitment/affiliate-detection.ts` |
| **2. Enrich** | email-finder + verify, DA/engagement signals; records a usage event | `recruitment/pipeline.ts` `enrich()`, `integrations/enrichment.ts` |
| **3. Score** | fit + propensity, weights **blended toward this merchant's producer outcomes** | `pipeline.ts` `score()` + `learning.ts` `weightsForMerchant()` |
| **4. Outreach** | send-as-merchant, tiered personalization, multi-step cadence (initial → follow-up → breakup) with send windows, per-mailbox caps, hard stops | `pipeline.ts`, `automation.ts` `advanceSequences()`, `sequencing.ts` |
| **5. Reply** | classify (LLM when configured, else keyword) → two-track router | `reply-router.ts` |
| **6. Closed loop** | append-only `ProspectOutcome` → source-yield pruning + learned scoring | `learning.ts`, `service.ts` `recordOutcome()` |

The scheduler (`worker.ts` `runScheduler`/`tickScheduler`) runs `autonomousCycle`
per merchant whose automation is `running`. Run it in-process with
`SCHEDULER=true npm run api`, or as a separate worker against Postgres/Redis.

## What requires a human vs. what's autonomous

| Autonomous | Human gate (deliberate) |
|---|---|
| Sourcing, enrichment, scoring, tiering | **A-tier (or below `hitlTier`) outreach approval** — held in the review queue |
| Auto-send for B/C ≥ `autoSendMinScore` | **Warm A-tier replies** — AI-SDR books a meeting; a human closes |
| Multi-step follow-ups, send-window/cap enforcement | (everything else runs unattended) |
| Long-tail interested replies → self-serve signup | |
| Suppression, geo-gating, circuit breaker | |

Tunable per merchant via `AutomationState` (`autoSendMinScore`, `hitlTier`,
`meetingTier`, `sourcingLimitPerCycle`) on the **Automation** dashboard page.

## External services — config-or-fallback, the "see how" answer

Every web-touching capability is a **port** with a deterministic local fallback
(default — runs offline, tests pass) and a real adapter skeleton wired for
production. The proxy/SERP/etc. decision is a config swap behind the port, never a
rewrite:

| Capability | Port | Default (offline) | Production adapter |
|---|---|---|---|
| Scrape HTTP | `HttpFetcher` | `DeterministicFetcher` | `ProxyHttpFetcher` + rotating/residential `ProxyPool` (**never the origin IP** — Section 11) |
| SERP | `SerpProvider` | `DeterministicSerpProvider` | `SerpApiProvider` (SerpApi/Serper key) |
| Backlinks | `DiscoverySource` | (defers to SERP) | `BacklinkDiscoverySource` (Ahrefs/SEMrush) |
| Email find/verify | `EmailFinder` | `StubEmailFinder` | `HunterFinder` (+ waterfall: Hunter→Findymail→Prospeo→ZeroBounce) |
| Reply ingest | `ReplyIngestionSource` | webhook (`/recruitment/reply-webhook/:merchantId`) | `ImapReplyIngestion` |
| LLM (AI-SDR + personalization) | `LlmClient` | `DeterministicLlm` | `AnthropicLlmClient` (Claude Opus 4.8) — auto-used when `ANTHROPIC_API_KEY` set |
| Meeting booking | `CalendarBooking` | `StubCalendarBooking` | `GoogleCalendarBooking` (reuses the mailbox OAuth) / `CalcomBooking` |
| Send mailbox | `MailboxSender` | `MockMailboxSender` | `GmailSender` / `MicrosoftGraphSender` |

## Deliverability & compliance (woven in)

- **Warmup** ramp + per-mailbox **daily caps** + **rotation** (`deliverability.ts`).
- **Circuit breaker**: pauses sending when bounce > 2% or complaints > 0.3%
  (Google/Yahoo/Microsoft 2025 bulk-sender posture).
- **CAN-SPAM**: real physical address + one-click List-Unsubscribe in every send.
- **GDPR/CASL**: EU + Canada cold outreach is geo-gated in `send()`.
- **Suppression**: global one-click unsubscribe honored across all merchants;
  hard bounces auto-suppress.

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
  merchant id); `parseProgramInput` → forgiving manual entry (paste a link / "Network id");
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
fabricate. `synthetic` flag on every prospect; provider signals null when unwired;
no invented links on failed fetch. In demo mode the Niche Map seeds + mines but won't
snowball (expansion needs a real fetcher/backlink key for co-promotion data).
