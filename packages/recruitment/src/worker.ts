import { InMemoryQueue, type JobQueue } from "./queue.js";
import type { RecruitmentDeps } from "./deps.js";
import { enrich, score, send } from "./pipeline.js";

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
