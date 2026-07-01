import { describe, it, expect } from "vitest";
import { microsoftOAuth, buildConsentUrl, exchangeCode, refreshAccessToken, type PostForm } from "../src/index.js";

const cfg = microsoftOAuth({ clientId: "cid", clientSecret: "sec", redirectUri: "https://api.me/oauth/microsoft/callback" });

function fakeHttp(json: any, capture?: (url: string, form: Record<string, string>) => void): PostForm {
  return {
    async post(url, form) {
      capture?.(url, form);
      return { status: 200, json };
    },
  };
}

describe("buildConsentUrl", () => {
  it("includes client_id, redirect_uri, scope, and state", () => {
    const url = new URL(buildConsentUrl(cfg, "state123", { loginHint: "jane@brand.com" }));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.me/oauth/microsoft/callback");
    expect(url.searchParams.get("state")).toBe("state123");
    expect(url.searchParams.get("scope")).toContain("Mail.Send");
    expect(url.searchParams.get("login_hint")).toBe("jane@brand.com");
  });
});

describe("exchangeCode / refreshAccessToken", () => {
  it("exchanges the auth code for tokens with a computed expiry", async () => {
    let sent: Record<string, string> | null = null;
    const t = await exchangeCode(cfg, "the-code", fakeHttp({ access_token: "at", refresh_token: "rt", expires_in: 3600 }, (_u, f) => (sent = f)));
    expect(sent!.grant_type).toBe("authorization_code");
    expect(sent!.code).toBe("the-code");
    expect(t.accessToken).toBe("at");
    expect(t.refreshToken).toBe("rt");
    expect(new Date(t.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("keeps the old refresh token when the provider doesn't return a new one", async () => {
    const t = await refreshAccessToken(cfg, "old-rt", fakeHttp({ access_token: "at2", expires_in: 3600 }));
    expect(t.accessToken).toBe("at2");
    expect(t.refreshToken).toBe("old-rt");
  });

  it("throws on a token-endpoint error", async () => {
    await expect(exchangeCode(cfg, "bad", fakeHttp({ error: "invalid_grant" }))).rejects.toThrow(/oauth token error/);
  });
});
