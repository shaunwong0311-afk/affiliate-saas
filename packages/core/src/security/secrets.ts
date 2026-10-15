import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Secret handling shared by every process (API, worker, recruitment engine). One place
 * decides what counts as "set", what counts as "strong enough for production", and how the
 * unsubscribe-link secret is resolved — so the side that SIGNS a link and the side that
 * VERIFIES it can never disagree.
 */

/** Signing secret used when nothing is configured. Development only — production refuses it. */
export const DEV_INSECURE_SECRET = "dev-insecure-secret-change-me";

/** Shortest secret production accepts (256 bits of hex is 64 characters; this is the floor). */
export const MIN_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;

/**
 * Read a secret from the environment. A variable that is present but empty (or only
 * whitespace) counts as UNSET: `.env` templates and compose pass-through both produce
 * `NAME=` lines, and an empty string must never become a signing or encryption key.
 */
export function envSecret(env: Env, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Values that are documentation, not secrets. Compared case-insensitively. */
const PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  DEV_INSECURE_SECRET,
  "change-me-in-prod",
  "change-me",
  "changeme",
  "secret",
  "password",
]);

/** Fragments that mark a template value however long it has been padded. */
const PLACEHOLDER_FRAGMENTS = ["change-me", "changeme", "change_me", "replace-me", "replace_me", "placeholder", "your-secret", "dev-insecure"];

/**
 * Why `value` is unfit to be a production secret, or null when it is acceptable. The reason
 * never contains the value itself, so it is safe to print at boot.
 */
export function secretWeakness(value: string): string | null {
  const v = value.trim();
  const lower = v.toLowerCase();
  if (PLACEHOLDER_SECRETS.has(lower) || PLACEHOLDER_FRAGMENTS.some((f) => lower.includes(f))) {
    return "is a placeholder value";
  }
  if (v.length < MIN_SECRET_LENGTH) return `must be at least ${MIN_SECRET_LENGTH} characters`;
  // A long run of one or two characters is length without entropy ("aaaa…", "0101…").
  if (new Set(v).size < 8) return "has too little variety to be a secret";
  return null;
}

/**
 * The secret that signs and verifies unsubscribe links: UNSUBSCRIBE_SECRET, else JWT_SECRET,
 * else (outside production only) the development default. The API route and the recruitment
 * engine both call this — it is the single definition.
 */
export function resolveUnsubscribeSecret(env: Env = process.env): string {
  const secret = envSecret(env, "UNSUBSCRIBE_SECRET") ?? envSecret(env, "JWT_SECRET");
  if (secret) return secret;
  if (env.NODE_ENV === "production") {
    throw new Error("UNSUBSCRIBE_SECRET or JWT_SECRET must be set in production");
  }
  return DEV_INSECURE_SECRET;
}

/**
 * Derive an independent key for one purpose from a master secret, so two features never
 * share key material even when only one secret is configured.
 */
export function deriveSecret(master: string, purpose: string): string {
  return createHmac("sha256", master).update(`affiliate-saas:${purpose}`, "utf8").digest("hex");
}

/**
 * Constant-time equality for two secrets of any length. Both sides are hashed first, so
 * neither the content nor the length of the expected value leaks through timing.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
