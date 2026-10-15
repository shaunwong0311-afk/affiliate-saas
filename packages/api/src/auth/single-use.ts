import { createHash } from "node:crypto";
import type { AppContext } from "../context.js";

/**
 * Bookkeeping that makes emailed link tokens SINGLE-USE (affiliate magic links in
 * magic-link.ts, team invites in invite.ts).
 *
 * A link token is a signed JWT carrying a random nonce. Issuing one records a hash of the
 * nonce under the subject's record; spending it removes that entry — so a token can be
 * exchanged exactly once, and a token that was used, has expired, or was never issued all
 * look the same to the caller.
 *
 * Records live in the secret store: encrypted at rest, shared by every process through the
 * database, and never part of any API response (the affiliate and user rows are returned
 * verbatim by several routes). Time is `Date.now()`, the clock the JWT helpers use, so the
 * record and the token can never disagree about expiry.
 */
export interface OutstandingToken {
  /** SHA-256 of the token's nonce — the token itself is never stored. */
  h: string;
  /** Unix seconds; mirrors the token's own `exp`. */
  exp: number;
  /** What the link is for (callers cap and expire purposes independently). */
  p: string;
}

export const hashNonce = (nonce: string): string => createHash("sha256").update(nonce, "utf8").digest("hex");
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Run `work` alone for `recordKey`. A record is read, changed and written back, so issuing
 * and spending run one at a time per subject — otherwise two simultaneous redemptions of the
 * same token would both find it, and two simultaneous issues would lose one link. This is an
 * in-process queue; pass `ctx` and the work also runs under `ctx.db.withLock`, which makes it
 * exact across several API instances sharing one database.
 */
const queues = new Map<string, Promise<void>>();

export function serialized<T>(recordKey: string, work: () => Promise<T>, ctx?: AppContext): Promise<T> {
  const previous = queues.get(recordKey) ?? Promise.resolve();
  const locked = ctx ? () => ctx.db.withLock(`single-use:${recordKey}`, work) : work;
  const run = previous.then(locked); // `previous` is a tail that never rejects
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(recordKey, tail);
  void tail.then(() => {
    if (queues.get(recordKey) === tail) queues.delete(recordKey);
  });
  return run;
}

/** `serialized` plus the cross-process database lock — what every issue and spend uses. */
export function serializedWith<T>(ctx: AppContext, recordKey: string, work: () => Promise<T>): Promise<T> {
  return serialized(recordKey, work, ctx);
}

/** The unexpired entries of a record. An unreadable record counts as empty (fail closed). */
export async function loadOutstanding(ctx: AppContext, recordKey: string): Promise<OutstandingToken[]> {
  const raw = await ctx.secrets.get(recordKey);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const now = nowSeconds();
  return parsed.filter(
    (entry): entry is OutstandingToken => !!entry && typeof entry.h === "string" && typeof entry.exp === "number" && entry.exp >= now && typeof entry.p === "string",
  );
}

/**
 * Add `entry` to a record while keeping it bounded: at most `perPurpose` entries of the
 * entry's own purpose (its oldest lapse first — one purpose can never push out another's
 * links) and `total` overall (only then the oldest of any purpose). Entries stay in issue order.
 */
export function appendOutstanding(outstanding: OutstandingToken[], entry: OutstandingToken, caps: { perPurpose: number; total: number }): OutstandingToken[] {
  const samePurpose = outstanding.filter((token) => token.p === entry.p);
  const lapsed = new Set(samePurpose.slice(0, Math.max(0, samePurpose.length + 1 - caps.perPurpose)));
  const kept = outstanding.filter((token) => !lapsed.has(token));
  return [...kept.slice(Math.max(0, kept.length + 1 - caps.total)), entry];
}

export async function saveOutstanding(ctx: AppContext, recordKey: string, tokens: OutstandingToken[]): Promise<void> {
  if (tokens.length === 0) await ctx.secrets.delete(recordKey);
  else await ctx.secrets.put(recordKey, JSON.stringify(tokens));
}
