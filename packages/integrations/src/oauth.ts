/**
 * OAuth 2.0 authorization-code flow for connecting a merchant's mailbox (OUTREACH-SPEC §3/§4).
 * Provider-agnostic: build a consent URL, exchange the returned code for tokens, and refresh
 * the access token on demand. Microsoft Graph first (delegated Mail.Send — no security audit,
 * works while unverified). Gmail uses the same shape (restricted scope; CASA is a later concern).
 * No SDK — plain `fetch` with form-encoded token requests; the HTTP client is injectable for tests.
 */

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
}

export interface PostForm {
  post(url: string, form: Record<string, string>): Promise<{ status: number; json: any }>;
}

// offline_access → refresh tokens; Mail.Send to send-as-the-user; Mail.Read for reply ingestion.
export const MICROSOFT_SCOPES = ["offline_access", "openid", "email", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/Mail.Read"];
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly", "openid", "email"];

export function microsoftOAuth(opts: { clientId: string; clientSecret: string; redirectUri: string }): OAuthProviderConfig {
  return {
    ...opts,
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: MICROSOFT_SCOPES,
  };
}

export function googleOAuth(opts: { clientId: string; clientSecret: string; redirectUri: string }): OAuthProviderConfig {
  return {
    ...opts,
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: GOOGLE_SCOPES,
  };
}

/** The consent URL to redirect the merchant to. `state` is a signed anti-CSRF token. */
export function buildConsentUrl(cfg: OAuthProviderConfig, state: string, opts: { loginHint?: string } = {}): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes.join(" "),
    state,
    access_type: "offline", // Google: needed to receive a refresh token
    prompt: "consent",
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
  });
  return `${cfg.authUrl}?${params.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO timestamp when the access token expires. */
  expiresAt: string;
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function tokenRequest(cfg: OAuthProviderConfig, extra: Record<string, string>, http?: PostForm): Promise<TokenSet> {
  const form = { client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, ...extra };
  const res = http ? await http.post(cfg.tokenUrl, form) : await postForm(cfg.tokenUrl, form);
  const j = res.json;
  if (!j?.access_token) throw new Error(`oauth token error (${res.status}): ${j?.error_description ?? j?.error ?? "no access_token"}`);
  const expiresAt = new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString();
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt };
}

/** Exchange the authorization code (from the callback) for the first token set. */
export function exchangeCode(cfg: OAuthProviderConfig, code: string, http?: PostForm): Promise<TokenSet> {
  return tokenRequest(cfg, { grant_type: "authorization_code", code }, http);
}

/** Refresh an expired access token. Providers may not return a new refresh token → keep the old. */
export async function refreshAccessToken(cfg: OAuthProviderConfig, refreshToken: string, http?: PostForm): Promise<TokenSet> {
  const t = await tokenRequest(cfg, { grant_type: "refresh_token", refresh_token: refreshToken }, http);
  return { ...t, refreshToken: t.refreshToken ?? refreshToken };
}
