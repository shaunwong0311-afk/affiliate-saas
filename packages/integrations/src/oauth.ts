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
  /**
   * The address of the account that actually CONSENTED, read from the OpenID Connect
   * `id_token` the token endpoint returns for the `openid email` scopes. Null when the
   * provider returned none. The connect flow compares it with the mailbox being connected:
   * consenting as a different account would otherwise send (and read mail) as someone else.
   */
  accountEmail?: string | null;
  /** Every address-like identity claim of that account (`email`, `preferred_username`,
   *  `upn`): a Microsoft sign-in name can differ from the mailbox's primary address. */
  accountEmails?: string[];
}

/**
 * The email claim of an OIDC `id_token`. The token is read, not signature-verified: it comes
 * straight from the provider's token endpoint over TLS in the authorization-code flow, which
 * OpenID Connect Core §3.1.3.7 accepts in place of checking the signature. Microsoft puts the
 * sign-in address in `preferred_username` when `email` is absent.
 */
function accountEmailsFromIdToken(idToken: unknown): string[] {
  if (typeof idToken !== "string") return [];
  const payload = idToken.split(".")[1];
  if (!payload) return [];
  const found: string[] = [];
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    for (const key of ["email", "preferred_username", "upn"]) {
      const v = claims[key];
      if (typeof v === "string" && /^[^\s@]+@[^\s@]+$/.test(v) && !found.includes(v.toLowerCase())) found.push(v.toLowerCase());
    }
  } catch {
    /* not a JWT we can read → unknown */
  }
  return found;
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
  const accountEmails = accountEmailsFromIdToken(j.id_token);
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null, expiresAt, accountEmail: accountEmails[0] ?? null, accountEmails };
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
