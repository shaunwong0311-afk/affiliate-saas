import { createHmac, timingSafeEqual, randomBytes, scryptSync } from "node:crypto";

/**
 * Minimal HS256 JWT + password hashing using only node:crypto — no external auth
 * dependency. Two principal kinds share the mechanism: merchant `user` tokens and
 * `affiliate` portal tokens, discriminated by the `kind` claim. (`affiliate_magic` and
 * `user_invite` are emailed single-use link tokens — never a session.)
 */

export type PrincipalKind = "user" | "affiliate" | "affiliate_magic" | "user_invite";

export interface JwtClaims {
  sub: string; // user id or affiliate id
  kind: PrincipalKind;
  email?: string;
  /** Single-use nonce of an emailed link token (`affiliate_magic`, `user_invite`) — see auth/single-use.ts. */
  jti?: string;
  /** The merchant a team-invite token (`user_invite`) invites its subject to. */
  mid?: string;
  /**
   * Support session: the merchant and the user who are viewing the portal as affiliate `sub`
   * (POST /admin/impersonate). Its presence makes the session read-only and merchant-scoped.
   */
  imp?: { merchantId: string; userId: string };
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function signJwt(claims: Omit<JwtClaims, "iat" | "exp">, secret: string, ttlSeconds = 7 * 24 * 3600): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload: JwtClaims = { ...claims, iat, exp: iat + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as JwtClaims;
    if (claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---- Password hashing (scrypt) ---------------------------------------------
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const hash = scryptSync(password, Buffer.from(saltHex, "hex"), 64);
  return safeEqual(hash.toString("hex"), hashHex);
}

/** scrypt hash of a random password that was thrown away — only its cost matters. */
const DUMMY_PASSWORD_HASH =
  "scrypt$83dd8bc7145c05f6d9b60590251fd5ce$0d2238ac755ac6e3076aa0160701157d6598adae1b936cc62c23d9e55a63a96cf270d1ee361ce29bbf4a02f2e8def08a99423158561d9d62ae4284c8d3b1f9fe";

/**
 * Check a login password in the same time whether or not there is anything to check it
 * against. For an unknown email (or an invitee with no password yet) the same scrypt work is
 * spent on a dummy hash and the answer is always false — otherwise the response time tells
 * a caller which addresses are registered.
 */
export function verifyPasswordOrDummy(password: string, stored: string | null | undefined): boolean {
  if (!stored || !stored.startsWith("scrypt$")) {
    verifyPassword(password, DUMMY_PASSWORD_HASH);
    return false;
  }
  return verifyPassword(password, stored);
}

// ---- API key hashing --------------------------------------------------------
// The stored value is an HMAC of the key under `pepper` (config: API_KEY_PEPPER, else derived
// from JWT_SECRET) — a database dump alone is not enough to test candidate keys offline.
export function generateApiKey(pepper: string): { plaintext: string; prefix: string; hashed: string } {
  const raw = randomBytes(24).toString("base64url");
  const prefix = `ak_${raw.slice(0, 6)}`;
  const plaintext = `${prefix}.${raw}`;
  return { plaintext, prefix, hashed: hashApiKey(plaintext, pepper) };
}

export function hashApiKey(plaintext: string, pepper: string): string {
  if (!pepper) throw new Error("API-key hashing needs a configured pepper");
  return createHmac("sha256", pepper).update(plaintext).digest("hex");
}
