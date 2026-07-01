import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { systemClock } from "@affiliate/core";
import { createDatabaseFromEnv } from "@affiliate/db";
import {
  HashingEmbedder,
  DeterministicLlm,
  AnthropicLlmClient,
  StubEmailFinder,
  MockMailboxSender,
  StubCalendarBooking,
  SerpDiscoverySource,
  CompetitorAffiliateSource,
  CreatorDiscoverySource,
  DbCustomerMiningSource,
} from "@affiliate/integrations";
import { InMemoryQueue, type JobQueue } from "./queue.js";
import type { RecruitmentDeps } from "./deps.js";
import { enrich, score, send } from "./pipeline.js";
import { autonomousCycle } from "./automation.js";
import { ingestReplies } from "./reply-router.js";

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
    await send(deps, messageId);
  });
}

/** Build a default in-memory queue with sensible per-stage rate governors. */
export function buildQueue(): JobQueue {
  return new InMemoryQueue({
    enrich: { perWindow: 30, windowMs: 60_000 }, // email-finder API budget
    send: { perWindow: 50, windowMs: 60_000 }, // per-mailbox daily cap proxy
  });
}

/**
 * The scheduler — drives the autonomous from-scratch engine. For every merchant
 * with automation `running`, it runs one `autonomousCycle` per tick (source →
 * enrich → score → auto-send + follow-ups, gated by the deliverability circuit
 * breaker and the HITL tier). In production this is a cron/interval; here it is a
 * single `tick()` plus a `loop()` so it is testable and embeddable.
 */
export async function tickScheduler(deps: RecruitmentDeps): Promise<{ merchants: number; cycles: unknown[]; replies: { mailboxes: number; polled: number; matched: number } }> {
  const states = await deps.db.automationStates.find((s) => s.status === "running");
  const cycles: unknown[] = [];
  for (const state of states) {
    cycles.push(await autonomousCycle(deps, state.merchantId));
  }
  // Pull inbound replies (SMTP-rail IMAP poll) across ALL connected mailboxes — replies
  // must be ingested even for merchants whose outbound automation is paused, so a human
  // who paused sending still sees answers + sequences still stop on reply.
  const replies = await ingestReplies(deps).catch(() => ({ mailboxes: 0, polled: 0, matched: 0 }));
  return { merchants: states.length, cycles, replies };
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
    } catch {
      /* isolate cycle failures */
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

/** Build the full recruitment dependency set from the environment (worker entrypoint). */
export async function buildDepsFromEnv(): Promise<RecruitmentDeps> {
  const db = await createDatabaseFromEnv();
  const llm = process.env.ANTHROPIC_API_KEY ? new AnthropicLlmClient({ apiKey: process.env.ANTHROPIC_API_KEY }) : new DeterministicLlm();
  return {
    db,
    embedder: new HashingEmbedder(),
    llm,
    emailFinder: new StubEmailFinder(),
    mailer: new MockMailboxSender(),
    discoverySources: [new SerpDiscoverySource(), new CompetitorAffiliateSource(), new CreatorDiscoverySource(), new DbCustomerMiningSource(db)],
    calendar: new StubCalendarBooking(),
    clock: systemClock,
  };
}

// ---- Standalone worker entrypoint (`npm run worker`) ------------------------
const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  buildDepsFromEnv()
    .then((deps) => {
      const queue = buildQueue();
      registerWorkers(queue, deps);
      const handle = runScheduler(deps, Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000));
      const drain = setInterval(() => void queue.drain().catch(() => {}), 5_000);
      // eslint-disable-next-line no-console
      console.log("recruitment worker running (scheduler + stage queue)");
      const shutdown = () => {
        handle.stop();
        clearInterval(drain);
        process.exit(0);
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
