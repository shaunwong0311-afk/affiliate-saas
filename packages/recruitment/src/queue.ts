/**
 * Durable job queue abstraction (Section 8.7 / 11). Each pipeline stage is a
 * worker pool over a queue with idempotent jobs, retries with backoff, and
 * per-external-API rate governors. The default is an in-memory queue so the
 * pipeline runs without Redis; production swaps a BullMQ/Redis adapter behind the
 * same `JobQueue` interface.
 */

export interface Job<T> {
  id: string;
  name: string;
  data: T;
  attempts: number;
  maxAttempts: number;
  runAt: number; // epoch ms
}

export type JobHandler<T> = (data: T, job: Job<T>) => Promise<void>;

export interface JobQueue {
  add<T>(name: string, data: T, opts?: { delayMs?: number; maxAttempts?: number }): Promise<string>;
  process<T>(name: string, handler: JobHandler<T>): void;
  /** Drain all ready jobs (used by the demo + tests to run the pipeline to completion). */
  drain(now?: number): Promise<{ processed: number; failed: number }>;
  size(): number;
}

/** A simple in-memory queue with retry/backoff and a per-name rate governor. */
export class InMemoryQueue implements JobQueue {
  private readonly jobs: Job<unknown>[] = [];
  private readonly handlers = new Map<string, JobHandler<any>>();
  private readonly rateLimits = new Map<string, { perWindow: number; windowMs: number; recent: number[] }>();
  private counter = 0;

  constructor(rateLimits?: Record<string, { perWindow: number; windowMs: number }>) {
    for (const [name, cfg] of Object.entries(rateLimits ?? {})) {
      this.rateLimits.set(name, { ...cfg, recent: [] });
    }
  }

  async add<T>(name: string, data: T, opts?: { delayMs?: number; maxAttempts?: number }): Promise<string> {
    const id = `job_${++this.counter}`;
    this.jobs.push({
      id,
      name,
      data,
      attempts: 0,
      maxAttempts: opts?.maxAttempts ?? 3,
      runAt: Date.now() + (opts?.delayMs ?? 0),
    });
    return id;
  }

  process<T>(name: string, handler: JobHandler<T>): void {
    this.handlers.set(name, handler);
  }

  private rateAllows(name: string, now: number): boolean {
    const rl = this.rateLimits.get(name);
    if (!rl) return true;
    rl.recent = rl.recent.filter((t) => now - t < rl.windowMs);
    if (rl.recent.length >= rl.perWindow) return false;
    rl.recent.push(now);
    return true;
  }

  async drain(now = Date.now()): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    // Iterate until no more ready jobs can run this pass.
    for (let guard = 0; guard < 10_000; guard++) {
      const idx = this.jobs.findIndex((j) => j.runAt <= now && this.handlers.has(j.name) && this.rateAllows(j.name, now));
      if (idx === -1) break;
      const job = this.jobs.splice(idx, 1)[0]!;
      const handler = this.handlers.get(job.name)!;
      try {
        job.attempts++;
        await handler(job.data, job);
        processed++;
      } catch (err) {
        if (job.attempts < job.maxAttempts) {
          job.runAt = now + Math.min(60_000, 1000 * 2 ** job.attempts); // exponential backoff
          this.jobs.push(job);
        } else {
          failed++;
        }
      }
    }
    return { processed, failed };
  }

  size(): number {
    return this.jobs.length;
  }
}
