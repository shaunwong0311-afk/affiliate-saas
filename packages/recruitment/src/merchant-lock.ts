import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "@affiliate/db";

/**
 * The per-merchant send lock (AUDIT-2026-10, shared contract 3). EVERY path that queues or
 * sends outreach for a merchant runs inside it — the autonomous cycle, a manual campaign
 * launch, a reply sent from the handoff queue or by autopilot, the stage-queue `send` job —
 * so two of them can never interleave their "is there capacity? → queue → send" steps. Without
 * it, an overlapping scheduler tick and "Run cycle" click emailed the same prospects twice
 * and overshot the mailbox's daily cap.
 *
 * It delegates to `db.withLock(key, fn)` (shared contract 2: a Postgres advisory lock, so it
 * also holds across the API process and the worker). Where the database adapter does not
 * provide `withLock`, it falls back to an in-process async mutex per key — correct for one
 * process only.
 *
 * Re-entrant within one async call chain: a function that takes the lock may call another
 * that takes it too (`launchCampaign` → `send`) without deadlocking, so the low-level
 * primitives can each protect themselves.
 */

type LockingDatabase = Database & { withLock?: <R>(key: string, fn: () => Promise<R>) => Promise<R> };

/** Keys held by the current async call chain (`active` flips off the moment it releases). */
const heldLocks = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

/** In-process fallback: one promise chain per key; each caller waits for the previous to finish. */
const chains = new Map<string, Promise<void>>();

async function localLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => gate);
  chains.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(key) === tail) chains.delete(key);
  }
}

/** Serialize `fn` against every other holder of `key` (re-entrant for the current call chain). */
export async function withKeyLock<R>(deps: { db: Database }, key: string, fn: () => Promise<R>): Promise<R> {
  const held = heldLocks.getStore();
  if (held?.get(key)?.active) return fn();
  const token = { active: true };
  const next = new Map(held ?? []);
  next.set(key, token);
  const run = (): Promise<R> =>
    heldLocks.run(next, async () => {
      try {
        return await fn();
      } finally {
        token.active = false;
      }
    });
  const db = deps.db as LockingDatabase;
  return typeof db.withLock === "function" ? db.withLock(key, run) : localLock(key, run);
}

/**
 * Run `fn` holding the merchant's send lock. Signature fixed by the shared contract:
 * `withMerchantLock(deps, merchantId, fn)`.
 */
export function withMerchantLock<R>(deps: { db: Database }, merchantId: string, fn: () => Promise<R>): Promise<R> {
  return withKeyLock(deps, `merchant-send:${merchantId}`, fn);
}

/**
 * Serialize a merchant's SOURCING runs (a separate key: a discovery run takes minutes and
 * must not hold up a reply send, but two of them overlapping would double the paid queries).
 */
export function withSourcingLock<R>(deps: { db: Database }, merchantId: string, fn: () => Promise<R>): Promise<R> {
  return withKeyLock(deps, `merchant-sourcing:${merchantId}`, fn);
}
