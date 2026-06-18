import { createHmac, timingSafeEqual, randomBytes, scryptSync } from "node:crypto";

/**
 * Minimal HS256 JWT + password hashing using only node:crypto — no external auth
 * dependency. Two principal kinds share the mechanism: merchant `user` tokens and
 * `affiliate` portal tokens, discriminated by the `kind` claim.
 */

export type PrincipalKind = "user" | "affiliate";

export interface JwtClaims {
  sub: string; // user id or affiliate id
  kind: PrincipalKind;
  email?: string;
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

// ---- API key hashing --------------------------------------------------------
export function generateApiKey(): { plaintext: string; prefix: string; hashed: string } {
  const raw = randomBytes(24).toString("base64url");
  const prefix = `ak_${raw.slice(0, 6)}`;
  const plaintext = `${prefix}.${raw}`;
  const hashed = createHmac("sha256", "apikey-pepper").update(plaintext).digest("hex");
  return { plaintext, prefix, hashed };
}

export function hashApiKey(plaintext: string): string {
  return createHmac("sha256", "apikey-pepper").update(plaintext).digest("hex");
}
