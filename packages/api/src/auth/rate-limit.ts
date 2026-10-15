import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { tooManyRequests } from "../errors.js";

/** `max` requests per `windowMs` for one key. */
export interface RateRule {
  max: number;
  windowMs: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the current window ends (for the Retry-After header). */
  retryAfterSeconds: number;
}

/** Credential / token guessing surface (login, signup, magic links). */
export const AUTH_LIMIT: RateRule = { max: 30, windowMs: 60_000 };
/** Public forms that create an affiliate row and can trigger a welcome email. */
export const PUBLIC_FORM_LIMIT: RateRule = { max: 10, windowMs: 10 * 60_000 };
/** The same forms, per submitted email address — holds whatever address the caller comes from. */
export const PUBLIC_FORM_PER_EMAIL_LIMIT: RateRule = { max: 5, windowMs: 60 * 60_000 };
/** Team invitations mail an address the inviter chose: bounded per invited address… */
export const TEAM_INVITE_PER_EMAIL_LIMIT: RateRule = { max: 5, windowMs: 60 * 60_000 };
/** …and per inviting merchant, so a tenant cannot use invitations as a mail cannon. */
export const TEAM_INVITE_PER_MERCHANT_LIMIT: RateRule = { max: 30, windowMs: 60 * 60_000 };
/**
 * Endpoints whose callers are authenticated by an HMAC or a shared secret (postbacks, reply
 * webhooks, the signed unsubscribe link). Guessing is not the risk there, and many end users
 * legitimately arrive from one provider address, so this is only a flood guard.
 */
export const SIGNED_ENDPOINT_LIMIT: RateRule = { max: 600, windowMs: 60_000 };

const SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_MAX_KEYS = 50_000;

/**
 * Fixed-window rate limiter, in memory, per process (a multi-instance deployment fronts it
 * with a shared store). Bounded by construction: expired windows are swept as requests
 * arrive (at most every 30 s; no timer to keep the process alive), and the table never
 * holds more than `maxKeys` entries — at the cap the windows that started longest ago are
 * dropped first.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly maxKeys: number;
  private readonly now: () => number;
  private nextSweepAt = 0;

  constructor(opts: { maxKeys?: number; now?: () => number } = {}) {
    this.maxKeys = Math.max(1, opts.maxKeys ?? DEFAULT_MAX_KEYS);
    this.now = opts.now ?? Date.now;
  }

  /** Count one request against `key`. */
  hit(key: string, rule: RateRule): RateDecision {
    const now = this.now();
    if (now >= this.nextSweepAt) this.sweep(now);

    const entry = this.hits.get(key);
    if (entry && now < entry.resetAt) {
      entry.count += 1;
      return { allowed: entry.count <= rule.max, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }

    // New window. Re-inserting keeps the map ordered by window start, which is what the
    // size cap evicts by.
    if (entry) this.hits.delete(key);
    else if (this.hits.size >= this.maxKeys) this.evictOldest();
    this.hits.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: rule.max >= 1, retryAfterSeconds: Math.max(1, Math.ceil(rule.windowMs / 1000)) };
  }

  /** Number of tracked keys (observability + tests). */
  get size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
    this.nextSweepAt = now + SWEEP_INTERVAL_MS;
  }

  /**
   * Make room for one more key by dropping the windows that started longest ago (the map
   * iterates in insertion order). Constant work per request — a flood of new keys cannot
   * turn the cap into a full-table scan on every hit.
   */
  private evictOldest(): void {
    for (const key of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

/** Count one hit against `key` and throw 429 when it is over `rule` (per-target buckets set by handlers). */
export function enforceRateLimit(limiter: RateLimiter, key: string, rule: RateRule): void {
  if (!limiter.hit(key, rule).allowed) throw tooManyRequests();
}

/**
 * The same, per INBOX: one bucket per (purpose, inbox) whatever client the requests come
 * from. The key is hashed — fixed-size whatever was submitted, and no address book in the
 * limiter table.
 */
export function enforceEmailRateLimit(limiter: RateLimiter, purpose: string, email: string, rule: RateRule): void {
  const hashed = createHash("sha256").update(inboxKey(email), "utf8").digest("hex");
  enforceRateLimit(limiter, `${purpose}|${hashed}`, rule);
}

/**
 * The inbox an address delivers to, as far as it can be told without asking the provider:
 * case-folded, any `+tag` dropped, and Gmail's ignored dots removed — so `a.b+1@gmail.com`,
 * `ab+2@googlemail.com`, … cannot each get a fresh bucket for the same mailbox. Used for
 * limiter keys only, never to rewrite a stored address.
 */
export function inboxKey(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/**
 * Per-address cap for the public apply / join forms: throws 429 once one email address has
 * been submitted `PUBLIC_FORM_PER_EMAIL_LIMIT.max` times in the window, whatever client or
 * merchant the submissions came through. Call it after the body has validated.
 */
export function enforcePublicFormEmailLimit(limiter: RateLimiter, email: string): void {
  enforceEmailRateLimit(limiter, "public-form-email", email, PUBLIC_FORM_PER_EMAIL_LIMIT);
}

/**
 * The limiter's notion of "one client". An IPv4 address stands for itself; an IPv6 client is
 * its /64 (the smallest block handed to a single subscriber — per-address keys would let one
 * machine rotate through 2^64 of them). IPv4-mapped IPv6 collapses to the IPv4 address.
 * Anything that is not an IP address at all (possible only when a proxy setting makes
 * `request.ip` come from a caller-written header) shares ONE bucket, so such values can
 * neither mint buckets nor grow the table with arbitrary strings.
 */
export function clientKey(ip: string | null | undefined): string {
  let addr = (ip ?? "").trim().toLowerCase();
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  if (isIPv4(addr)) return addr;
  if (!isIPv6(addr)) return "unknown";

  const groups = expandIPv6(addr);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** Eight 16-bit groups of an address `isIPv6` already accepted. */
function expandIPv6(addr: string): number[] {
  let text = addr;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    // Trailing dotted quad (::ffff:1.2.3.4) is the last two groups.
    const o = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${(((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16)}:${(((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const zeros = rest === undefined ? 0 : Math.max(0, 8 - left.length - right.length);
  return [...left, ...Array<string>(zeros).fill("0"), ...right].map((g) => parseInt(g, 16) || 0);
}
