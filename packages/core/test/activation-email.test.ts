import { describe, it, expect } from "vitest";
import { buildActivationEmail, commissionLineFromOffer, firstSaleBonusText, type Offer } from "../src/index.js";

const baseInput = {
  affiliateName: "Trail Geek",
  merchantName: "Lumen Skincare",
  magicLink: "https://app/#/portal/verify?token=xyz",
  portalUrl: "https://app/#/portal",
  trackingUrl: "https://track/c/ABC123",
  personalCode: "TRAIL10",
  commissionLine: "You earn 15% on every sale.",
  fastStartDeadline: "July 15",
  fastStartBonus: null as string | null,
  termsUrl: "https://lumen/terms",
};

function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: "off1",
    merchantId: "m1",
    programId: "prog1",
    engine: "affiliate",
    name: "Default",
    payoutType: "percentage",
    payoutValue: 0.15,
    currency: "USD",
    windowDays: 30,
    rules: [],
    tiers: [],
    bonuses: [],
    overridePolicy: null,
    status: "active",
    ...over,
  } as Offer;
}

describe("buildActivationEmail", () => {
  it("leads with the one-click magic link and includes link + code + commission", () => {
    const { subject, text } = buildActivationEmail(baseInput);
    expect(subject).toContain("Lumen Skincare");
    expect(text).toContain("https://app/#/portal/verify?token=xyz");
    expect(text).toContain("no password needed");
    expect(text).toContain("https://track/c/ABC123");
    expect(text).toContain("TRAIL10");
    expect(text).toContain("You earn 15% on every sale.");
    expect(text).toContain("July 15");
  });

  it("uses the fast-start GOAL framing when there is no real bonus (never invents one)", () => {
    const { subject, text } = buildActivationEmail({ ...baseInput, fastStartBonus: null });
    expect(subject).toBe("You're in — start earning with Lumen Skincare");
    expect(text).toContain("Fast-start goal");
    expect(text).not.toContain("bonus");
  });

  it("promotes the bonus in the subject + body only when it is real", () => {
    const { subject, text } = buildActivationEmail({ ...baseInput, fastStartBonus: "earn a 20.00 USD bonus on your first sale." });
    expect(subject).toContain("fast-start bonus");
    expect(text).toContain("earn a 20.00 USD bonus on your first sale.");
  });

  it("omits the tools block gracefully when there is no offer yet (no link/code)", () => {
    const { text } = buildActivationEmail({ ...baseInput, trackingUrl: null, personalCode: null });
    expect(text).not.toContain("Your tools are ready");
    expect(text).toContain("/portal/verify"); // sign-in CTA still present
  });
});

describe("commissionLineFromOffer", () => {
  it("formats a percentage offer, trimming trailing zeros", () => {
    expect(commissionLineFromOffer(offer({ payoutValue: 0.15 }))).toBe("You earn 15% on every sale.");
    expect(commissionLineFromOffer(offer({ payoutValue: 0.125 }))).toBe("You earn 12.5% on every sale.");
  });

  it("formats a flat offer as money per sale", () => {
    expect(commissionLineFromOffer(offer({ payoutType: "flat", payoutValue: 1200, currency: "USD" }))).toBe("You earn 12.00 USD per sale.");
  });

  it("honors a per-relationship override rate", () => {
    expect(commissionLineFromOffer(offer(), { rate: 0.25 })).toBe("You earn 25% on every sale.");
  });

  it("returns null when there is no offer", () => {
    expect(commissionLineFromOffer(null)).toBeNull();
  });
});

describe("firstSaleBonusText", () => {
  it("returns copy only for a real first_sale bonus", () => {
    const withBonus = offer({ bonuses: [{ id: "b1", offerId: "off1", triggerType: "first_sale", threshold: 1, amountCents: 2000 }] });
    expect(firstSaleBonusText(withBonus)).toBe("earn a 20.00 USD bonus on your first sale.");
  });

  it("returns null when no bonus is configured (never promises one)", () => {
    expect(firstSaleBonusText(offer())).toBeNull();
    expect(firstSaleBonusText(offer({ bonuses: [{ id: "b1", offerId: "off1", triggerType: "conversion_count", threshold: 5, amountCents: 1000 }] }))).toBeNull();
  });
});
