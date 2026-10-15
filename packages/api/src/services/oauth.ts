import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { microsoftOAuth, googleOAuth, type OAuthProviderConfig } from "@affiliate/integrations";
import type { AppConfig } from "../config.js";

export type OAuthProviderName = "microsoft" | "google";

/** Build the OAuth provider config from env-loaded credentials, or null if not configured. */
export function oauthProviderFor(config: AppConfig, provider: OAuthProviderName): OAuthProviderConfig | null {
  const redirectUri = `${config.publicApiUrl}/oauth/${provider}/callback`;
  if (provider === "microsoft" && config.oauth.microsoft) return microsoftOAuth({ ...config.oauth.microsoft, redirectUri });
  if (provider === "google" && config.oauth.google) return googleOAuth({ ...config.oauth.google, redirectUri });
  return null;
}

// ---- Signed, short-lived OAuth "state" (anti-CSRF; carries the mailbox target) ----
interface StatePayload {
  mailboxId: string;
  merchantId: string;
  provider: OAuthProviderName;
  exp: number;
  /**
   * Single-use nonce. The connect request stores it on the mailbox (`oauthNonce`); the
   * callback accepts a state only while it matches, and clears it. A signature and an expiry
   * alone left the state replayable for its whole lifetime.
   */
  nonce: string;
}

/** A fresh nonce for one connect request. */
export function newOAuthNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function signOAuthState(payload: Omit<StatePayload, "exp" | "nonce"> & { nonce?: string }, secret: string, ttlSeconds = 600): string {
  const body = Buffer.from(JSON.stringify({ ...payload, nonce: payload.nonce ?? newOAuthNonce(), exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyOAuthState(state: string, secret: string): StatePayload | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as StatePayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.nonce !== "string" || !payload.nonce) return null;
    return payload;
  } catch {
    return null;
  }
}
