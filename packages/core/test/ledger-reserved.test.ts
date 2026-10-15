import { describe, it, expect } from "vitest";
import { AffiliateEngine, applyReversal, computeBalances, type LedgerEntry, type ReversalEvent } from "../src/index.js";
import { makeOffer, makeOnOrderContext } from "./fixtures.js";

const now = new Date("2026-06-01T12:00:00Z");
const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: "led_1",
  merchantId: "merch_1",
  affiliateId: "aff_seller",
  conversionId: "conv_1",
  type: "commission",
  amountCents: 2_000,
  currency: "USD",
  status: "approved",
  availableAt: null,
  ts: now.toISOString(),
  reversesEntryId: null,
  metadata: {},
  ...overrides,
});
const reversalOf = (e: LedgerEntry): ReversalEvent => ({
  reversesEntryId: e.id,
  affiliateId: e.affiliateId,
  amount: { amountCents: -e.amountCents, currency: e.currency },
  conversionId: e.conversionId,
  reason: "refund",
});

// AUDIT-2026-10 M4: a refund on an entry a payout had reserved was treated as "unpaid" —
// the entry was voided while the payout still sent the money, and nothing clawed it back.
describe("reversing an entry a payout has reserved", () => {
  it("once the payout has been handed over, it is clawed back like a paid entry", () => {
    const reserved = entry({ status: "processing", metadata: { payoutId: "pay_1" } });
    const { reversalEntry, originalNewStatus } = applyReversal(reserved, reversalOf(reserved), { merchantId: "merch_1", now, disbursementStarted: true });
    expect(originalNewStatus).toBe("processing"); // stays in the payout
    expect(reversalEntry.status).toBe("approved"); // negative, owed back
    expect(reversalEntry.amountCents).toBe(-2_000);
    expect(reversalEntry.metadata.reversedFromStatus).toBe("processing");

    // Paid out later: 2,000 paid, 2,000 owed back.
    const settled = computeBalances([{ ...reserved, status: "paid" }, reversalEntry], now).get("USD")!;
    expect(settled).toMatchObject({ paidCents: 2_000, availableCents: -2_000 });
    // Payout failed instead: the released entry and the clawback cancel out.
    const released = computeBalances([{ ...reserved, status: "approved" }, reversalEntry], now).get("USD")!;
    expect(released).toMatchObject({ paidCents: 0, availableCents: 0 });
  });

  it("assumes the money may have moved unless told the payout is still a draft", () => {
    const reserved = entry({ status: "processing" });
    expect(applyReversal(reserved, reversalOf(reserved), { merchantId: "merch_1", now }).reversalEntry.status).toBe("approved");
  });

  it("while the payout is still a draft, the entry is simply voided", () => {
    const reserved = entry({ status: "processing" });
    const { reversalEntry, originalNewStatus } = applyReversal(reserved, reversalOf(reserved), { merchantId: "merch_1", now, disbursementStarted: false });
    expect(originalNewStatus).toBe("reversed");
    expect(reversalEntry.status).toBe("reversed");
  });

  it("leaves the existing unpaid and paid cases as they were", () => {
    const unpaid = entry({ status: "approved" });
    expect(applyReversal(unpaid, reversalOf(unpaid), { merchantId: "merch_1", now, disbursementStarted: true })).toMatchObject({
      originalNewStatus: "reversed",
      reversalEntry: { status: "reversed" },
    });
    const paid = entry({ status: "paid" });
    expect(applyReversal(paid, reversalOf(paid), { merchantId: "merch_1", now, disbursementStarted: false })).toMatchObject({
      originalNewStatus: "paid",
      reversalEntry: { status: "approved" },
    });
  });
});

// AUDIT-2026-10 M13: reserved money appeared in no bucket at all.
describe("balances account for reserved entries", () => {
  it("counts `processing` entries, negatives included, in their own bucket", () => {
    const balance = computeBalances(
      [
        entry({ id: "a", status: "processing", amountCents: 10_000 }),
        entry({ id: "b", status: "processing", amountCents: -3_000, type: "adjustment" }),
        entry({ id: "c", status: "approved", amountCents: 500 }),
        entry({ id: "d", status: "paid", amountCents: 700 }),
      ],
      now,
    ).get("USD")!;
    expect(balance).toMatchObject({ processingCents: 7_000, availableCents: 500, paidCents: 700, pendingCents: 0, onHoldCents: 0 });
  });
});

// AUDIT-2026-10 M10: a milestone bonus was earned again after a refund pulled the count back.
describe("milestone bonuses are earned once", () => {
  const engine = new AffiliateEngine();
  const offer = makeOffer({
    bonuses: [
      { id: "b_count", offerId: "offer_1", triggerType: "conversion_count", threshold: 2, amountCents: 5_000 },
      { id: "b_volume", offerId: "offer_1", triggerType: "lifetime_volume", threshold: 15_000, amountCents: 7_000 },
      { id: "b_first", offerId: "offer_1", triggerType: "first_sale", threshold: 1, amountCents: 2_500 },
    ],
  });
  const bonuses = (ctx: Parameters<typeof makeOnOrderContext>[0]) =>
    engine
      .onOrder(makeOnOrderContext({ offer, ...ctx }))
      .filter((e) => e.type === "bonus")
      .map((e) => e.metadata!.bonusId);

  it("crossing a threshold the affiliate already holds the bonus for pays nothing more", () => {
    const crossing = { priorConversionCount: 1, priorVolumeCents: 10_000, isFirstConversionForAffiliate: false };
    expect(bonuses(crossing)).toEqual(["b_count", "b_volume"]);
    expect(bonuses({ ...crossing, awardedBonusIds: ["b_count"] })).toEqual(["b_volume"]);
    expect(bonuses({ ...crossing, awardedBonusIds: ["b_count", "b_volume"] })).toEqual([]);
    expect(bonuses({ priorConversionCount: 0, priorVolumeCents: 0, isFirstConversionForAffiliate: true, awardedBonusIds: ["b_first"] })).toEqual([]);
  });
});
