/**
 * Errors every Database adapter raises in the same shape, so callers never branch on
 * which adapter is wired. (Before, the in-memory store threw typed errors and the
 * Postgres adapter threw whatever the driver produced.)
 */

export class NotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`row not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/** A second row with the same primary key. */
export class DuplicateKeyError extends Error {
  constructor(public readonly id: string) {
    super(`duplicate key: ${id}`);
    this.name = "DuplicateKeyError";
  }
}

/**
 * A write would break a declared uniqueness rule (see `constraints.ts`). Carries an HTTP
 * status so a route that never anticipated the race still answers 409, not 500.
 */
export class UniqueViolationError extends Error {
  readonly statusCode = 409;
  readonly code = "unique_violation";
  constructor(
    /** The constraint's `name` from UNIQUE_CONSTRAINTS. */
    public readonly constraint: string,
    public readonly collection: string,
    public readonly fields: readonly string[],
  ) {
    super(`duplicate value for ${collection}(${fields.join(", ")})`);
    this.name = "UniqueViolationError";
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): err is UniqueViolationError {
  return err instanceof UniqueViolationError && (constraint === undefined || err.constraint === constraint);
}

/**
 * A statement failed earlier in this transaction, so nothing else can run in it and it
 * cannot commit. Postgres behaves this way natively; the in-memory adapter mirrors it so
 * code that swallows a failed write breaks in tests instead of only in production. Wrap a
 * write that is allowed to fail in a nested `transaction()` (a savepoint) and catch outside.
 */
export class TransactionAbortedError extends Error {
  constructor() {
    super("transaction is aborted: an earlier statement failed, so it can only roll back");
    this.name = "TransactionAbortedError";
  }
}

/** Gave up waiting for a lock (`withLock`, or `transaction(..., { lock })`). Safe to retry. */
export class LockTimeoutError extends Error {
  readonly statusCode = 503;
  readonly code = "lock_timeout";
  constructor(
    public readonly key: string,
    public readonly waitedMs: number,
  ) {
    super(`timed out after ${waitedMs}ms waiting for lock "${key}" — another operation is still running; retry shortly`);
    this.name = "LockTimeoutError";
  }
}
