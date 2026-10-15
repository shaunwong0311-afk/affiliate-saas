import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryDatabase, type Database, type Prospect, type Suppression } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { signUnsubscribeToken, verifyUnsubscribeToken, resolveUnsubscribeSecret } from "@affiliate/core";
import { appliesGlobally, handleReply, isSuppressed, suppress, suppressionsAffecting, unsubscribeLink, type RecruitmentDeps } from "../src/index.js";

/**
 * AUDIT-2026-10 S2 (read side) + S4 (unsubscribe secret). A suppression applies to every
 * merchant only when it is global AND came from a system path; a row a tenant created never
 * reaches past its own merchant. And the link the engine signs is verified with the same
 * secret-resolution rule the API uses.
 */
let db: Database;
const NOW = new Date("2026-10-12T12:00:00.000Z");

function makeDeps(): RecruitmentDeps {
  return { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock: { now: () => NOW } };
}

const row = (over: Partial<Suppression>): Suppression => ({ id: `supp_${Math.random()}`, merchantId: null, email: null, domain: null, reason: "manual", scope: "merchant", ts: NOW.toISOString(), ...over });

function prospect(merchantId: string, email: string): Prospect {
  return { id: `p_${merchantId}_${email}`, merchantId, source: "serp", identity: "Creator", siteUrl: null, channelUrl: null, email, state: "scored", score: 60, tier: "B", country: "US", language: "en", suppressionStatus: "none", scoreBreakdown: null, synthetic: false, confidence: 0.6, evidence: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } as Prospect;
}

/** A prospect of `merchantId` that an outreach email was really delivered to. */
async function emailed(merchantId: string, email: string): Promise<Prospect> {
  const p = await db.prospects.insert({ ...prospect(merchantId, email), state: "contacted" });
  await db.outreachMessages.insert({ id: `om_${p.id}`, prospectId: p.id, campaignId: "c1", step: 1, variant: null, subject: "s", body: "b", sentAt: NOW.toISOString(), status: "sent" });
  return p;
}

beforeEach(() => {
  db = createMemoryDatabase();
});

describe("which suppressions apply to whom (S2)", () => {
  it("a merchant-scope row binds only its own merchant", async () => {
    await db.suppressions.insert(row({ merchantId: "m1", domain: "spam.example", origin: "merchant" }));
    expect(await isSuppressed(makeDeps(), "m1", "x@spam.example")).toBe(true);
    expect(await isSuppressed(makeDeps(), "m2", "x@spam.example")).toBe(false);
  });

  it("a tenant-created row never applies globally — even one stored with scope=global", async () => {
    // What the old API wrote for scope=global (no `origin`, reason "manual", merchantId null)…
    await db.suppressions.insert(row({ scope: "global", domain: "gmail.com" }));
    // …and the same thing with the new provenance field set.
    await db.suppressions.insert(row({ scope: "global", email: "rival@brand.com", origin: "merchant", merchantId: "m1" }));

    expect(await isSuppressed(makeDeps(), "m1", "anyone@gmail.com")).toBe(false);
    expect(await isSuppressed(makeDeps(), "m2", "anyone@gmail.com")).toBe(false);
    expect(await isSuppressed(makeDeps(), "m2", "rival@brand.com")).toBe(false);
    expect(await isSuppressed(makeDeps(), "m1", "rival@brand.com")).toBe(true); // its creator's own outreach is still bound
  });

  it("a system path suppresses for every merchant when it answers mail that was really sent", async () => {
    await emailed("m1", "stop@example.com");
    await suppress(makeDeps(), { merchantId: "m1", email: "Stop@Example.com", reason: "unsubscribe", scope: "global" });
    const stored = (await db.suppressions.all())[0]!;
    expect(stored).toMatchObject({ origin: "system", scope: "global", merchantId: "m1" });
    expect(appliesGlobally(stored)).toBe(true);
    expect(await isSuppressed(makeDeps(), "m1", "stop@example.com")).toBe(true);
    expect(await isSuppressed(makeDeps(), "m2", "STOP@example.com")).toBe(true);
  });

  it("a pasted 'reply' for an address the merchant never emailed binds that merchant only (no silencing an address for everyone by typing STOP)", async () => {
    // Exactly what an operator can do with no mail involved: import an address, paste a reply.
    const imported = await db.prospects.insert(prospect("m1", "victim@creator.com"));
    await db.merchants.insert({ id: "m1", name: "Rival", status: "active", niche: "x", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: NOW.toISOString() });
    const outcome = await handleReply(makeDeps(), imported.id, "STOP");
    expect(outcome.action).toBe("suppress");

    const stored = (await db.suppressions.all())[0]!;
    expect(stored).toMatchObject({ scope: "merchant", merchantId: "m1", email: "victim@creator.com", reason: "unsubscribe" });
    expect(await isSuppressed(makeDeps(), "m1", "victim@creator.com")).toBe(true); // honoured for the merchant that recorded it
    expect(await isSuppressed(makeDeps(), "m2", "victim@creator.com")).toBe(false); // …and nobody else

    // The same reply after a delivered email IS platform-wide.
    const mailed = await emailed("m1", "real-optout@creator.com");
    await handleReply(makeDeps(), mailed.id, "STOP");
    expect(await isSuppressed(makeDeps(), "m2", "real-optout@creator.com")).toBe(true);
  });

  it("never grants platform-wide scope to a whole domain, a failed send, or a request without a merchant", async () => {
    await emailed("m1", "someone@gmail.com");
    await suppress(makeDeps(), { merchantId: "m1", domain: "gmail.com", reason: "complaint", scope: "global" });
    expect(await isSuppressed(makeDeps(), "m2", "anyone@gmail.com")).toBe(false);
    expect(await isSuppressed(makeDeps(), "m1", "anyone@gmail.com")).toBe(true);

    const notDelivered = await db.prospects.insert(prospect("m1", "never-reached@creator.com"));
    await db.outreachMessages.insert({ id: "om_failed", prospectId: notDelivered.id, campaignId: "c1", step: 1, variant: null, subject: "s", body: "b", sentAt: null, status: "failed" });
    await suppress(makeDeps(), { merchantId: "m1", email: "never-reached@creator.com", reason: "unsubscribe", scope: "global" });
    expect(await isSuppressed(makeDeps(), "m2", "never-reached@creator.com")).toBe(false);

    await expect(suppress(makeDeps(), { merchantId: null, email: "x@y.com", reason: "unsubscribe", scope: "global" })).rejects.toThrow(/must name the merchant/);
  });

  it("rows written before `origin` existed keep working: an unsubscribe / complaint is system, 'manual' is not", () => {
    expect(appliesGlobally({ scope: "global", reason: "unsubscribe" })).toBe(true);
    expect(appliesGlobally({ scope: "global", reason: "complaint" })).toBe(true);
    expect(appliesGlobally({ scope: "global", reason: "manual" })).toBe(false);
    expect(appliesGlobally({ scope: "merchant", reason: "unsubscribe", origin: "system" })).toBe(false);
  });

  it("a bounce stays a merchant-scope row", async () => {
    await suppress(makeDeps(), { merchantId: "m1", email: "gone@example.com", reason: "hard bounce", scope: "merchant" });
    expect(await isSuppressed(makeDeps(), "m1", "gone@example.com")).toBe(true);
    expect(await isSuppressed(makeDeps(), "m2", "gone@example.com")).toBe(false);
  });
});

describe("suppressionsAffecting — what a merchant's list shows (S2)", () => {
  it("own rows + platform rows that hit its prospects (attribution removed); nothing else", async () => {
    await db.prospects.insert(prospect("m2", "shared@creator.com"));
    await db.prospects.insert(prospect("m2", "writer@blocked-domain.com"));
    // Two people m1 really emailed opt out…
    await emailed("m1", "shared@creator.com");
    await emailed("m1", "stranger@elsewhere.com");
    await suppress(makeDeps(), { merchantId: "m1", email: "shared@creator.com", reason: "unsubscribe", scope: "global" });
    await suppress(makeDeps(), { merchantId: "m1", email: "stranger@elsewhere.com", reason: "unsubscribe", scope: "global" });
    // …and a platform-level domain block (only the operator can create one — never suppress()).
    await db.suppressions.insert(row({ merchantId: "m1", domain: "blocked-domain.com", reason: "complaint", scope: "global", origin: "system" }));
    await db.suppressions.insert(row({ merchantId: "m2", email: "own@m2.com", origin: "merchant" }));
    await db.suppressions.insert(row({ merchantId: "m3", email: "shared@creator.com", origin: "merchant" })); // another tenant's private row

    const m2 = await suppressionsAffecting(makeDeps(), "m2");
    expect(m2.map((s) => s.email ?? s.domain).sort()).toEqual(["blocked-domain.com", "own@m2.com", "shared@creator.com"]);
    expect(m2.find((s) => s.email === "shared@creator.com")!.merchantId).toBeNull();
    expect(m2.find((s) => s.domain === "blocked-domain.com")!.merchantId).toBeNull();
    expect(m2.find((s) => s.email === "own@m2.com")!.merchantId).toBe("m2");

    const m1 = await suppressionsAffecting(makeDeps(), "m1");
    expect(m1).toHaveLength(3);
    expect(m1.every((s) => s.merchantId === "m1")).toBe(true);
  });
});

describe("unsubscribeLink signs with the shared secret resolution (S4)", () => {
  const saved = { UNSUBSCRIBE_SECRET: process.env.UNSUBSCRIBE_SECRET, JWT_SECRET: process.env.JWT_SECRET, PUBLIC_API_URL: process.env.PUBLIC_API_URL };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const tokenOf = (link: string) => new URL(link).searchParams.get("t")!;
  const JWT = "2c4e6a8c0e2b4d6f8a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b";
  const UNSUB = "f1d3b5a7c9e0f2d4b6a8c0e1f3d5b7a9c2e4f6d8b0a1c3e5";

  it("an empty UNSUBSCRIBE_SECRET / JWT_SECRET never becomes the signing key", () => {
    process.env.UNSUBSCRIBE_SECRET = "";
    process.env.JWT_SECRET = JWT;
    process.env.PUBLIC_API_URL = "https://api.example.com";
    const link = unsubscribeLink("m1", "Reader@Example.com");
    expect(link.startsWith("https://api.example.com/track/unsubscribe?m=m1&e=Reader%40Example.com&t=")).toBe(true);
    expect(tokenOf(link)).toBe(signUnsubscribeToken("m1", "reader@example.com", JWT));
    expect(tokenOf(link)).not.toBe(signUnsubscribeToken("m1", "reader@example.com", ""));
    // Whatever verifies with the shared helper accepts it.
    expect(verifyUnsubscribeToken("m1", "reader@example.com", tokenOf(link), resolveUnsubscribeSecret())).toBe(true);

    process.env.JWT_SECRET = "";
    expect(tokenOf(unsubscribeLink("m1", "reader@example.com"))).toBe(signUnsubscribeToken("m1", "reader@example.com", "dev-insecure-secret-change-me"));
  });

  it("UNSUBSCRIBE_SECRET wins over JWT_SECRET", () => {
    process.env.UNSUBSCRIBE_SECRET = UNSUB;
    process.env.JWT_SECRET = JWT;
    expect(tokenOf(unsubscribeLink("m1", "reader@example.com"))).toBe(signUnsubscribeToken("m1", "reader@example.com", UNSUB));
  });

  it("an empty PUBLIC_API_URL falls back to the default instead of producing a relative link", () => {
    process.env.PUBLIC_API_URL = "";
    expect(unsubscribeLink("m1", "reader@example.com").startsWith("http://localhost:8787/track/unsubscribe?")).toBe(true);
  });
});
