import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { signUnsubscribeToken } from "@affiliate/core";
import type { Prospect } from "@affiliate/db";
import { buildApp } from "../src/app.js";

/**
 * AUDIT-2026-10 S1 — the unsubscribe POST must accept what REAL clients send. Nobody posts
 * JSON here: the confirm page's own form submits an empty urlencoded body, and a mailbox
 * provider's RFC 8058 one-click button posts `List-Unsubscribe=One-Click` as urlencoded or
 * multipart. With only a JSON parser registered every one of them got HTTP 415 and nobody
 * was suppressed. (The old test posted with no body at all — the one shape that worked.)
 */
const SECRET = "dev-insecure-secret-change-me"; // the development default both sides resolve to
const MERCHANT = "m_unsub";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});

function unsubscribeUrl(email: string, token = signUnsubscribeToken(MERCHANT, email, SECRET)): string {
  return `/track/unsubscribe?m=${encodeURIComponent(MERCHANT)}&e=${encodeURIComponent(email)}&t=${token}`;
}

function globalRowFor(email: string) {
  return app.appContext.db.suppressions.findOne((s) => s.scope === "global" && s.email === email);
}

function prospect(email: string): Prospect {
  const now = new Date().toISOString();
  return { id: `prosp_${email}`, merchantId: MERCHANT, source: "serp", identity: "Creator", siteUrl: null, channelUrl: null, email, state: "contacted", score: 60, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: now, updatedAt: now } as Prospect;
}

describe("unsubscribe accepts the request shapes real clients send (S1)", () => {
  it("the confirm page's own form: urlencoded with an EMPTY body, posted to the form's action", async () => {
    const email = "form@example.com";
    await app.appContext.db.prospects.insert(prospect(email));
    const pageUrl = unsubscribeUrl(email);
    const page = await app.inject({ method: "GET", url: pageUrl });
    expect(page.statusCode).toBe(200);

    // Submit the form the way a browser does: resolve its action against the page URL and
    // post an empty application/x-www-form-urlencoded body (the form has no named fields).
    const action = /<form[^>]*\baction="([^"]*)"/.exec(page.body)?.[1];
    expect(action).toBeDefined();
    const target = new URL(action!.replace(/&amp;/g, "&"), `http://api.test${pageUrl}`);
    expect(target.pathname).toBe("/track/unsubscribe");

    const res = await app.inject({
      method: "POST",
      url: target.pathname + target.search,
      headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "0" },
      payload: "",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("unsubscribed");
    expect(await globalRowFor(email)).toMatchObject({ reason: "unsubscribe", scope: "global", merchantId: MERCHANT });
    expect((await app.appContext.db.prospects.require(`prosp_${email}`)).state).toBe("suppressed");
  });

  it("RFC 8058 one-click: `List-Unsubscribe=One-Click` as application/x-www-form-urlencoded", async () => {
    for (const [email, contentType] of [
      ["oneclick@example.com", "application/x-www-form-urlencoded"],
      ["oneclick-charset@example.com", "application/x-www-form-urlencoded; charset=UTF-8"],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: unsubscribeUrl(email),
        headers: { "content-type": contentType },
        payload: "List-Unsubscribe=One-Click",
      });
      expect(res.statusCode, contentType).toBe(200);
      expect(await globalRowFor(email), contentType).not.toBeNull();
    }
  });

  it("RFC 8058 one-click as multipart/form-data", async () => {
    const email = "multipart@example.com";
    const boundary = "----unsubBoundary7MA4YWxk";
    const res = await app.inject({
      method: "POST",
      url: unsubscribeUrl(email),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${boundary}--\r\n`,
    });
    expect(res.statusCode).toBe(200);
    expect(await globalRowFor(email)).not.toBeNull();
  });

  it("is idempotent — a second click does not add a second global row", async () => {
    const email = "twice@example.com";
    const post = () =>
      app.inject({ method: "POST", url: unsubscribeUrl(email), headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" });
    expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(200);
    expect(await app.appContext.db.suppressions.count((s) => s.email === email)).toBe(1);
  });

  it("an unsigned or tampered link is still refused, whatever the body looks like", async () => {
    const email = "victim@example.com";
    for (const url of [`/track/unsubscribe?e=${encodeURIComponent(email)}`, unsubscribeUrl(email, "0".repeat(32)), `${unsubscribeUrl(email)}&e=other@example.com`]) {
      const res = await app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" });
      expect(res.statusCode, url).toBe(400);
    }
    expect(await app.appContext.db.suppressions.count(() => true)).toBe(0);
  });

  it("does not loosen body parsing anywhere else — JSON routes still reject form posts", async () => {
    for (const url of ["/auth/login", "/track/click", "/webhooks/inbound"]) {
      const res = await app.inject({ method: "POST", url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "email=a%40b.co&password=x" });
      expect(res.statusCode, url).toBe(415);
    }
  });

  it("bounds the body it is willing to read", async () => {
    const email = "big@example.com";
    const res = await app.inject({ method: "POST", url: unsubscribeUrl(email), headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "x=".padEnd(64 * 1024, "y") });
    expect(res.statusCode).toBe(413);
    expect(await globalRowFor(email)).toBeNull();
  });
});
