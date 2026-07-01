import { describe, it, expect } from "vitest";
import {
  topicGate,
  buildMerchantKb,
  answerFromKb,
  buildGroundedSdrPrompt,
  isNeedsHuman,
  summarizeReply,
  type Offer,
  type MerchantKb,
} from "../src/index.js";

function offer(over: Partial<Offer> = {}): Offer {
  return { id: "off1", merchantId: "m1", programId: "prog1", engine: "affiliate", name: "Default", payoutType: "percentage", payoutValue: 0.15, currency: "USD", windowDays: 30, rules: [], tiers: [], bonuses: [], overridePolicy: null, status: "active", ...over } as Offer;
}

describe("topicGate", () => {
  const cases: [string, string, boolean][] = [
    ["Can we negotiate a higher commission rate?", "rate_negotiation", true],
    ["Do you offer a custom deal or a flat fee?", "custom_deal", true],
    ["I need to review the contract with my lawyer first", "legal", true],
    ["Can we hop on a call next week?", "meeting", true],
    ["I didn't get paid for last month's sales", "payment_issue", true],
    ["What's your commission rate?", "commission_question", false],
    ["How long does the cookie window last?", "cookie_window_question", false],
    ["When do I get paid out?", "payout_question", false],
    ["How do I sign up for the program?", "how_to_join", false],
    ["Does the serum ship internationally?", "product_question", false],
    ["Sounds interesting, tell me more about it", "general_question", false],
  ];
  it.each(cases)("classifies %j → %s (human=%s)", (text, topic, mustBeHuman) => {
    const g = topicGate(text);
    expect(g.topic).toBe(topic);
    expect(g.mustBeHuman).toBe(mustBeHuman);
  });
});

describe("buildMerchantKb", () => {
  it("assembles grounded facts from the program + default offer", () => {
    const kb = buildMerchantKb({
      merchantName: "Lumen",
      program: { approvalMode: "auto", holdDays: 14, termsUrl: "https://lumen/terms" },
      offers: [offer({ windowDays: 45, payoutValue: 0.2 })],
      faqs: [{ question: "Do you ship worldwide?", answer: "Yes." }],
    });
    expect(kb.commissionLine).toBe("You earn 20% on every sale.");
    expect(kb.cookieWindowDays).toBe(45);
    expect(kb.payoutHoldDays).toBe(14);
    expect(kb.howToJoin).toContain("approved instantly");
    expect(kb.faqs).toHaveLength(1);
  });
});

describe("answerFromKb", () => {
  const kb: MerchantKb = {
    merchantName: "Lumen",
    commissionLine: "You earn 15% on every sale.",
    cookieWindowDays: 30,
    payoutHoldDays: 14,
    approvalMode: "auto",
    howToJoin: "Sign up through the link and you're approved instantly.",
    termsUrl: null,
    faqs: [{ question: "Do you offer international shipping?", answer: "Yes, we ship to most countries in 5-7 days." }],
  };

  it("answers commission / cookie / payout / how-to-join deterministically from the KB", () => {
    expect(answerFromKb(kb, "commission_question", "what's the rate?")).toContain("15%");
    expect(answerFromKb(kb, "cookie_window_question", "how long?")).toContain("30 days");
    expect(answerFromKb(kb, "payout_question", "when paid?")).toContain("14-day hold");
    expect(answerFromKb(kb, "how_to_join", "how join?")).toContain("approved instantly");
  });

  it("matches a curated FAQ for a product question when overlap is strong", () => {
    expect(answerFromKb(kb, "product_question", "How does international shipping work?")).toContain("ship to most countries");
  });

  it("returns null (→ human) when a fact is missing or no FAQ matches", () => {
    expect(answerFromKb({ ...kb, commissionLine: null }, "commission_question", "rate?")).toBeNull();
    expect(answerFromKb(kb, "general_question", "what's your refund philosophy on Tuesdays?")).toBeNull();
  });
});

describe("grounded prompt + NEEDS_HUMAN", () => {
  it("instructs the model to answer only from the KB and decline otherwise", () => {
    const kb = buildMerchantKb({ merchantName: "Lumen", program: null, offers: [], faqs: [] });
    const p = buildGroundedSdrPrompt(kb, "what's your best seller?");
    expect(p.system).toContain("ONLY");
    expect(p.system).toContain("NEEDS_HUMAN");
    expect(p.user).toContain("what's your best seller?");
  });

  it("detects a declined answer (and treats empty as declined)", () => {
    expect(isNeedsHuman("NEEDS_HUMAN")).toBe(true);
    expect(isNeedsHuman("  needs_human  ")).toBe(true);
    expect(isNeedsHuman("")).toBe(true);
    expect(isNeedsHuman("You earn 15% on every sale.")).toBe(false);
  });
});

describe("summarizeReply", () => {
  it("prefixes the topic and truncates long text", () => {
    const s = summarizeReply("hey, " + "x".repeat(300), "rate_negotiation");
    expect(s).toContain("rate negotiation");
    expect(s.length).toBeLessThan(200);
  });
});
