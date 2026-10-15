import { InMemoryQueue, type JobQueue } from "./queue.js";
import { loggerOf, type RecruitmentDeps } from "./deps.js";
import { enrich, score, send } from "./pipeline.js";
import { autonomousCycle, setAutomationState, type CycleSummary } from "./automation.js";
import { ingestReplies } from "./reply-router.js";
import { capacityAvailable } from "./deliverability.js";
import { withMerchantLock } from "./merchant-lock.js";

/**
 * Stage workers over a durable queue (Section 8.7). Each stage is registered as a
 * handler; idempotent jobs with retries/backoff and per-API rate governors. The
 * default queue is in-memory; production registers the same handlers on a
 * BullMQ/Redis-backed queue. Run as `npm run worker`.
 */
export function registerWorkers(queue: JobQueue, deps: RecruitmentDeps): void {
  queue.process<{ prospectId: string }>("enrich", async ({ prospectId }) => {
    await enrich(deps, prospectId);
    await queue.add("score", { prospectId });
  });
  queue.process<{ prospectId: string }>("score", async ({ prospectId }) => {
    await score(deps, prospectId);
  });
  queue.process<{ messageId: string }>("send", async ({ messageId }) => {
    // A queued send obeys the same rules as every other send path: the merchant's send lock,
    // and the campaign mailbox's window / daily cap / backoff, re-checked inside it.
    const message = await deps.db.outreachMessages.require(messageId);
    const prospect = await deps.db.prospects.require(message.prospectId);
    await withMerchantLock(deps, prospect.merchantId, async () => {
      const campaign = await deps.db.campaigns.get(message.campaignId);
      if (campaign && !(await capacityAvailable(deps, prospect.merchantId, campaign, deps.clock.now()))) {
        throw new Error("no send capacity right now — retry later");
      }
      await send(deps, messageId);
    });
  });
}

/** Build a default in-memory queue with sensible per-stage rate governors. */
export function buildQueue(): JobQueue {
  return new InMemoryQueue({
    enrich: { perWindow: 30, windowMs: 60_000 }, // email-finder API budget
    send: { perWindow: 50, windowMs: 60_000 }, // per-mailbox daily cap proxy
  });
}

export interface TickError {
  merchantId: string | null;
  phase: "replies" | "cycle";
  error: string;
}

export interface TickResult {
  merchants: number;
  cycles: unknown[];
  replies: { mailboxes: number; polled: number; matched: number; bounced?: number; failed?: number };
  /** What went wrong this tick, per merchant. Empty on a clean tick. */
  errors: TickError[];
}

/**
 * The scheduler — drives the autonomous from-scratch engine. One `tick()`:
 *
 *  1. reads every connected mailbox for replies and bounces — ALWAYS, and FIRST: for merchants
 *     whose automation is paused too, and whatever happens to any merchant's cycle afterwards.
 *     A reply or STOP that has arrived is processed before anyone is emailed again;
 *  2. runs one `autonomousCycle` for each merchant with automation `running` (sourcing only
 *     when its interval has elapsed; sends and follow-ups every tick, gated by the
 *     deliverability circuit breaker and the HITL tier).
 *
 * Merchants are ISOLATED (AUDIT-2026-10 O1): one merchant's failure is caught, logged,
 * recorded on its automation state and returned in `errors`; every other merchant still gets
 * its cycle. Nothing is swallowed silently. In production this is a cron/interval; here it is
 * a single `tick()` plus a `loop()` so it is testable and embeddable.
 */
export async function tickScheduler(deps: RecruitmentDeps): Promise<TickResult> {
  const log = loggerOf(deps);
  const errors: TickError[] = [];

  let replies: TickResult["replies"] = { mailboxes: 0, polled: 0, matched: 0 };
  try {
    replies = await ingestReplies(deps);
  } catch (e) {
    const error = errorMessage(e);
    errors.push({ merchantId: null, phase: "replies", error });
    log.error("reply ingestion failed", { error });
  }

  const states = await deps.db.automationStates.find((s) => s.status === "running");
  const cycles: unknown[] = [];
  for (const state of states) {
    try {
      // The inbox was read just above for every mailbox — the cycle need not read it again.
      const summary: CycleSummary = await autonomousCycle(deps, state.merchantId, { skipReplyIngestion: true });
      cycles.push(summary);
    } catch (e) {
      const error = errorMessage(e);
      errors.push({ merchantId: state.merchantId, phase: "cycle", error });
      log.error("autonomous cycle failed", { merchantId: state.merchantId, error });
      // Make it visible to the operator, not just to whoever reads the logs.
      await setAutomationState(deps, state.merchantId, { lastError: error.slice(0, 300), lastErrorAt: deps.clock.now().toISOString() }).catch(() => {});
    }
  }
  return { merchants: states.length, cycles, replies, errors };
}

export interface SchedulerHandle {
  stop(): void;
}

/** Run the scheduler on an interval (production worker entrypoint). */
export function runScheduler(deps: RecruitmentDeps, intervalMs = 60_000): SchedulerHandle {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    try {
      await tickScheduler(deps);
    } catch (e) {
      // tickScheduler isolates per merchant; reaching here means the tick itself broke (the
      // database is unreachable, say). Log it and keep the loop alive for the next interval.
      loggerOf(deps).error("scheduler tick failed", { error: errorMessage(e) });
    }
    if (!stopped) timer = setTimeout(run, intervalMs);
  };
  let timer = setTimeout(run, intervalMs);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The standalone worker ENTRYPOINT lives in packages/api/src/worker.ts — it builds the same
// fully-wired AppContext as the API server (env-gated sources, real mailbox resolver + secret
// store, reply poller, ESP, notifier). This package deliberately has no env wiring of its own:
// a second, drifting dependency factory is how production ends up sending through a mock.
