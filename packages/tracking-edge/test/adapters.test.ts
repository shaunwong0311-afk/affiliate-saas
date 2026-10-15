import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import { DbLinkResolver, DbClickSink } from "../src/adapters.js";
import { createRedirectHandler } from "../src/handler.js";

/**
 * AUDIT-2026-10 M11 at the edge: the link resolver looked only at "some relationship with
 * the merchant is active" — a paused offer kept redirecting (and recording clicks), a
 * banned affiliate's links kept working, and a relationship in a DIFFERENT program of the
 * same merchant was enough.
 */
let db: Database;

const offer = (id: string, programId: string, status: "active" | "paused" = "active") =>
  ({ id, merchantId: "m1", programId, engine: "affiliate", name: id, payoutType: "percentage", payoutValue: 0.1, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null, status }) as const;
const relationship = (affiliateId: string, programId: string, status: "active" | "pending" | "paused" | "banned" | "rejected" = "active") =>
  ({ id: `r_${affiliateId}_${programId}`, affiliateId, merchantId: "m1", programId, status, joinedAt: "2026-01-01T00:00:00Z", role: "seller", commissionTerms: null, source: "x", ownerUserId: null, tags: [], sponsorAffiliateId: null, prospectId: null }) as const;
const affiliate = (id: string, status: "active" | "paused" | "banned" = "active") =>
  ({ id, name: id, primaryEmail: `${id}@x.test`, country: null, audienceProfile: null, status, createdAt: "2026-01-01T00:00:00Z" }) as const;

beforeEach(async () => {
  db = createMemoryDatabase();
  await db.offers.insert({ ...offer("o1", "p1") });
  await db.affiliates.insert({ ...affiliate("a1") });
  await db.relationships.insert({ ...relationship("a1", "p1"), tags: [] });
});

describe("DbLinkResolver", () => {
  const resolve = (code: string) => new DbLinkResolver(db, { defaultDestination: "https://shop.test/" }).resolve(code);

  it("resolves a link that can earn", async () => {
    expect(await resolve("a1.o1")).toEqual({ merchantId: "m1", affiliateId: "a1", offerId: "o1", destinationUrl: "https://shop.test/" });
  });

  it("does not resolve a paused offer's link", async () => {
    await db.offers.update("o1", { status: "paused" });
    expect(await resolve("a1.o1")).toBeNull();
  });

  it("does not resolve a paused or banned affiliate's link", async () => {
    for (const status of ["paused", "banned"] as const) {
      await db.affiliates.update("a1", { status });
      expect(await resolve("a1.o1")).toBeNull();
    }
  });

  it("does not resolve when the relationship is anything but active", async () => {
    for (const status of ["pending", "paused", "banned", "rejected"] as const) {
      await db.relationships.update("r_a1_p1", { status });
      expect(await resolve("a1.o1"), status).toBeNull();
    }
  });

  it("needs a relationship in THIS offer's program, not just any with the merchant", async () => {
    await db.offers.insert({ ...offer("o2", "p2") });
    expect(await resolve("a1.o2")).toBeNull(); // a1 is only in p1
    await db.relationships.insert({ ...relationship("a1", "p2"), tags: [] });
    expect(await resolve("a1.o2")).toMatchObject({ offerId: "o2" });
    // Banned from p1, still active in p2: the p2 link works, the p1 link does not.
    await db.relationships.update("r_a1_p1", { status: "banned" });
    expect(await resolve("a1.o1")).toBeNull();
    expect(await resolve("a1.o2")).not.toBeNull();
  });

  it("rejects unknown ids and malformed codes", async () => {
    for (const code of ["ghost.o1", "a1.nope", "a1", ".o1", "a1.", ""]) expect(await resolve(code), code).toBeNull();
  });
});

describe("redirect + click sink over the store", () => {
  it("a paused offer neither redirects nor records a click", async () => {
    const handler = createRedirectHandler(new DbLinkResolver(db, { defaultDestination: "https://shop.test/" }), new DbClickSink(db));
    const hit = async () => {
      const deferred: Promise<unknown>[] = [];
      const decision = await handler({ code: "a1.o1", url: new URL("https://track.test/c/a1.o1?sub1=yt"), ip: "1.2.3.4", ua: "t", defer: (p) => deferred.push(p) });
      await Promise.all(deferred);
      return decision.status;
    };
    expect(await hit()).toBe(302);
    expect(await db.clicks.count()).toBe(1);
    expect((await db.clicks.all())[0]).toMatchObject({ merchantId: "m1", affiliateId: "a1", offerId: "o1", sub1: "yt" });
    await db.offers.update("o1", { status: "paused" });
    expect(await hit()).toBe(404);
    expect(await db.clicks.count()).toBe(1);
  });
});
