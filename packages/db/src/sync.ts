import { LockTimeoutError } from "./errors.js";

/** How long a caller waits for a lock before failing with LockTimeoutError. */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * FIFO per-key mutex for ONE process. The in-memory adapter's locks are exactly this; the
 * Postgres adapter puts it in front of its advisory locks so that N callers in a process
 * contend here, in order and without each holding a database connection while they wait.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Resolves with a release function once every earlier caller on `key` has released.
   * Rejects with LockTimeoutError after `timeoutMs` (the caller's place in the queue is
   * given up cleanly, so later callers are not blocked by it).
   */
  async acquire(key: string, timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    const release = () => {
      open();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const turn = previous.then(() => "acquired" as const);
    const outcome = Number.isFinite(timeoutMs)
      ? await Promise.race([
          turn,
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), Math.min(Math.max(0, timeoutMs), MAX_TIMER_MS));
          }),
        ])
      : await turn;
    if (timer) clearTimeout(timer);

    if (outcome === "timeout") {
      void previous.then(release);
      throw new LockTimeoutError(key, timeoutMs);
    }
    return release;
  }
}

/** A lock this async context holds. `released` flips when it is let go, so work that outlives the lock cannot ride on it. */
export interface HeldLock {
  released: boolean;
}

/** What an adapter keeps in AsyncLocalStorage: the open transaction scope and the locks held. */
export interface Ambient<Tx> {
  tx: Tx | null;
  locks: ReadonlyMap<string, HeldLock>;
}

export const NO_LOCKS: ReadonlyMap<string, HeldLock> = new Map();

/** True when this async context already holds `key` (locks are re-entrant per context). */
export function holds(locks: ReadonlyMap<string, HeldLock> | undefined, key: string): boolean {
  const held = locks?.get(key);
  return !!held && !held.released;
}

export function withHeld(locks: ReadonlyMap<string, HeldLock> | undefined, key: string, held: HeldLock): ReadonlyMap<string, HeldLock> {
  const next = new Map(locks ?? NO_LOCKS);
  next.set(key, held);
  return next;
}

/** Keys of the two independent lock namespaces. */
export const sessionLockKey = (key: string): string => `lock:${key}`;
export const transactionLockKey = (key: string): string => `tx:${key}`;
