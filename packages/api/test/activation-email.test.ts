import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database } from "@affiliate/db";
import type { TransactionalEmail, TransactionalMailer, TransactionalResult } from "@affiliate/integrations";
import { createContext, type AppContext } from "../src/context.js";
import { sendActivationEmail } from "../src/services/activation-email.js";

class RecordingMailer implements TransactionalMailer {
  readonly provider = "recording";
  readonly sent: TransactionalEmail[] = [];
  next: TransactionalResult = { id: "r1", status: "sent" };
  async send(email: TransactionalEmail): Promise<TransactionalResult> {
    this.sent.push(email);
    return this.next;
  }
}

let db: Database;
let mailer: RecordingMailer;
let ctx: AppContext;

async function seed(opts: { approvalMode?: "auto" | "manual"; withOffer?: boolean; withBonus?: boolean; relStatus?: "active" | "pending" } = {}) {
  await db.merchants.insert({ id: "m1", name: "Lumen Skincare", status: "active", niche: "skincare", competitors: [], billingStatus: "active", defaultCurrency: "USD", postbackSecret: "s", physicalAddress: null, createdAt: new Date().toISOString() });
  await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: "https://lumen/terms", approvalMode: opts.approvalMode ?? "auto", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
  if (opts.withOffer !== false) {
    await db.offers.insert({ id: "off1", merchantId: "m1", programId: "prog1", engine: "affiliate", name: "Default Offer", payoutType: "percentage", payoutValue: 0.15, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: opts.withBonus ? [{ id: "b1", offerId: "off1", triggerType: "first_sale", threshold: 1, amountCents: 2000 }] : [], overridePolicy: null, status: "active" });
  }
  await db.affiliates.insert({ id: "aff1", name: "Trail Geek", primaryEmail: "hi@trailgeek.com", country: "US", audienceProfile: null, status: "active", createdAt: new Date().toISOString() });
  await db.relationships.insert({ id: "rel1", affiliateId: "aff1", merchantId: "m1", programId: "prog1", status: opts.relStatus ?? "active", joinedAt: new Date().toISOString(), role: "seller", commissionTerms: null, source: "recruitment", ownerUserId: null, tags: [], sponsorAffiliateId: null, prospectId: null });
}

beforeEach(() => {
  db = createMemoryDatabase();
  mailer = new RecordingMailer();
  ctx = createContext({ db, transactionalMailer: mailer });
});

describe("sendActivationEmail", () => {
  it("sends a welcome with a magic link, tracking link, personal code, and commission line", async () => {
    await seed();
    const res = await sendActivationEmail(ctx, "rel1");
    expect(res.sent).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    const email = mailer.sent[0];
    expect(email.to).toBe("hi@trailgeek.com");
    expect(email.text).toContain("/portal/verify?token="); // passwordless magic link
    expect(email.text).toContain(ctx.config.trackingBaseUrl + "/c/"); // pre-generated tracking link
    expect(email.text).toContain("You earn 15% on every sale."); // real commission
    // A personal attribution code was minted and referenced.
    const code = await db.codes.findOne((c) => c.affiliateId === "aff1" && c.merchantId === "m1");
    expect(code).toBeTruthy();
    expect(code!.kind).toBe("referral");
    expect(email.text).toContain(code!.code);
  });

  it("is idempotent — a second call does not re-send", async () => {
    await seed();
    await sendActivationEmail(ctx, "rel1");
    const again = await sendActivationEmail(ctx, "rel1");
    expect(again).toEqual({ sent: false, reason: "already sent" });
    expect(mailer.sent).toHaveLength(1);
    expect((await db.relationships.require("rel1")).activationEmailSentAt).toBeTruthy();
  });

  it("reuses an existing code instead of minting a second one", async () => {
    await seed();
    await sendActivationEmail(ctx, "rel1");
    await ctx.db.relationships.update("rel1", { activationEmailSentAt: null }); // allow a resend
    await sendActivationEmail(ctx, "rel1");
    expect(await db.codes.count((c) => c.affiliateId === "aff1")).toBe(1);
  });

  it("promotes a real first-sale bonus when the offer has one", async () => {
    await seed({ withBonus: true });
    await sendActivationEmail(ctx, "rel1");
    expect(mailer.sent[0].text).toContain("20.00 USD bonus on your first sale");
  });

  it("skips a pending (not-yet-approved) relationship", async () => {
    await seed({ relStatus: "pending" });
    const res = await sendActivationEmail(ctx, "rel1");
    expect(res).toEqual({ sent: false, reason: "relationship not active" });
    expect(mailer.sent).toHaveLength(0);
  });

  it("still sends when the program has no offer yet — no tracking link, but the code stands in", async () => {
    await seed({ withOffer: false });
    const res = await sendActivationEmail(ctx, "rel1");
    expect(res.sent).toBe(true);
    expect(mailer.sent[0].text).not.toContain("Your tracking link"); // no offer → no link
    expect(mailer.sent[0].text).toContain("Your personal code"); // code still delivered
  });
});
