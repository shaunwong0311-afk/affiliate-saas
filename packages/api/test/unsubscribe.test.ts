import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { signUnsubscribeToken } from "@affiliate/core";
import { buildApp } from "../src/app.js";

/**
 * The unsubscribe endpoint is destructive (global suppression) and public — it must be
 * HMAC-signed (no enumeration attacks) and must not suppress on GET (link prefetchers).
 */
let app: FastifyInstance;
const SECRET = "dev-insecure-secret-change-me"; // the dev default the route falls back to

beforeAll(async () => {
  app = await buildApp();
});

describe("hardened unsubscribe endpoint", () => {
  const email = "victim@example.com";
  const merchantId = "m_test";
  const token = signUnsubscribeToken(merchantId, email, SECRET);
  const qs = `m=${encodeURIComponent(merchantId)}&e=${encodeURIComponent(email)}&t=${token}`;

  it("rejects unsigned requests (no enumeration mass-suppression)", async () => {
    const res = await app.inject({ method: "GET", url: `/track/unsubscribe?e=${email}` });
    expect(res.statusCode).toBe(400);
    const post = await app.inject({ method: "POST", url: `/track/unsubscribe?e=${email}&m=${merchantId}&t=wrong` });
    expect(post.statusCode).toBe(400);
  });

  it("GET renders a confirm page WITHOUT suppressing (prefetcher-safe)", async () => {
    const res = await app.inject({ method: "GET", url: `/track/unsubscribe?${qs}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Unsubscribe");
    expect(res.body).toContain("form"); // the confirm button
    // A second GET still shows the form — nothing was suppressed by fetching the link.
    const again = await app.inject({ method: "GET", url: `/track/unsubscribe?${qs}` });
    expect(again.body).toContain("form");
  });

  it("signed POST performs the suppression (RFC 8058 one-click + the confirm form)", async () => {
    const res = await app.inject({ method: "POST", url: `/track/unsubscribe?${qs}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("unsubscribed");
  });
});
