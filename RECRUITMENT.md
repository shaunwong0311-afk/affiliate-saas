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
