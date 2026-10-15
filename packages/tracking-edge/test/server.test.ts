import { describe, it, expect, afterEach } from "vitest";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import { createEdgeServer, resolveDefaultDestination } from "../src/server.js";
import { decodeLinkCode } from "../src/handler.js";
import worker from "../src/worker.js";

/**
 * AUDIT-2026-10 S13 — `/c/%E0%A4%A` made `decodeURIComponent` throw inside the request
 * listener (an uncaught exception in the edge process). A malformed link is the caller's
 * mistake: 400, and the server keeps serving.
 */
let server: Server | undefined;

async function listen(db: Database): Promise<number> {
  server = createEdgeServer(db, { defaultDestination: "https://shop.example/landing" });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A raw request: the path is sent exactly as written (fetch would refuse or normalize some of these). */
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, location: res.headers.location }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function seededDb(): Promise<Database> {
  const db = createMemoryDatabase();
  const now = new Date().toISOString();
  await db.offers.insert({ id: "off1", merchantId: "m1", programId: "prog1", engine: "affiliate", name: "Offer", payoutType: "percentage", payoutValue: 0.2, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null, status: "active" });
  await db.affiliates.insert({ id: "aff1", name: "Creator", primaryEmail: "c@example.com", country: "US", audienceProfile: null, status: "active", createdAt: now });
  await db.relationships.insert({ id: "rel1", affiliateId: "aff1", merchantId: "m1", programId: "prog1", status: "active", joinedAt: now, role: "seller", commissionTerms: null, source: "manual", ownerUserId: null, tags: [], sponsorAffiliateId: null, prospectId: null });
  return db;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections(); // keep-alive sockets from the test client would hold close() open
    await new Promise((resolve) => server!.close(resolve));
  }
  server = undefined;
});

describe("Node tracking edge answers malformed requests instead of throwing (S13)", () => {
  it("400 for a malformed percent-escape in the code — and keeps serving afterwards", async () => {
    const port = await listen(await seededDb());

    for (const path of ["/c/%E0%A4%A", "/c/%", "/c/abc%zz"]) {
      const res = await raw(port, path);
      expect(res.status, path).toBe(400);
      expect(res.body, path).toBe("malformed tracking link");
    }

    // The process is still alive and a real link still redirects.
    const ok = await raw(port, "/c/aff1.off1");
    expect(ok.status).toBe(302);
    expect(ok.location).toMatch(/^https:\/\/shop\.example\/landing\?click_id=[0-9a-f-]{36}$/);
  });

  it("400 for a request target or Host header that cannot be parsed as a URL", async () => {
    const port = await listen(await seededDb());
    expect((await raw(port, "//")).status).toBe(400);
    expect((await raw(port, "/c/aff1.off1", { host: "[" })).status).toBe(400);
    expect((await raw(port, "/health")).status).toBe(200);
  });

  it("an encoded but well-formed code still resolves (decoding is unchanged)", async () => {
    const port = await listen(await seededDb());
    expect((await raw(port, "/c/aff1%2Eoff1")).status).toBe(302);
    expect((await raw(port, "/c/unknown.code")).status).toBe(404);
  });

  it("exposes /health for the container health check", async () => {
    const port = await listen(createMemoryDatabase());
    expect(await raw(port, "/health")).toMatchObject({ status: 200, body: "ok" });
  });
});

describe("Cloudflare Worker entry (S13)", () => {
  it("400 for a malformed code without touching KV or the queue", async () => {
    let kvReads = 0;
    const env = { LINKS: { get: async () => (kvReads++, null) }, CLICKS: { send: async () => {} } };
    const res = await worker.fetch(new Request("https://track.example/c/%E0%A4%A"), env, { waitUntil: () => {} });
    expect(res.status).toBe(400);
    expect(kvReads).toBe(0);

    const unknown = await worker.fetch(new Request("https://track.example/c/nope"), env, { waitUntil: () => {} });
    expect(unknown.status).toBe(404);
    expect(kvReads).toBe(1);
  });
});

describe("decodeLinkCode", () => {
  it("decodes a valid segment and returns null for a malformed one", () => {
    expect(decodeLinkCode("aff1%2Eoff1")).toBe("aff1.off1");
    expect(decodeLinkCode("plain")).toBe("plain");
    expect(decodeLinkCode("%E0%A4%A")).toBeNull();
  });
});

describe("EDGE_DEFAULT_DEST", () => {
  it("production refuses to start without a real destination (no redirecting clicks to a placeholder)", () => {
    expect(() => resolveDefaultDestination({ NODE_ENV: "production" })).toThrow(/EDGE_DEFAULT_DEST must be set/);
    expect(() => resolveDefaultDestination({ NODE_ENV: "production", EDGE_DEFAULT_DEST: "  " })).toThrow(/EDGE_DEFAULT_DEST must be set/);
    expect(() => resolveDefaultDestination({ NODE_ENV: "production", EDGE_DEFAULT_DEST: "not a url" })).toThrow(/not a valid URL/);
    expect(() => resolveDefaultDestination({ NODE_ENV: "production", EDGE_DEFAULT_DEST: "javascript:alert(1)" })).toThrow(/http\(s\)/);
    expect(resolveDefaultDestination({ NODE_ENV: "production", EDGE_DEFAULT_DEST: "https://shop.example/" })).toBe("https://shop.example/");
  });

  it("development keeps the reserved example host as its default", () => {
    expect(resolveDefaultDestination({})).toBe("https://example.com/");
  });
});
