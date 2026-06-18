import { describe, it, expect } from "vitest";
import {
  AffiliateEngine,
  commissionEventToEntry,
  applyReversal,
  computeBalances,
  type LedgerEntry,
} from "../src/index.js";
import { makeOnOrderContext } from "./fixtures.js";

const engine = new AffiliateEngine();
const now = new Date("2026-06-01T12:00:00Z");

function entriesFromOrder(): LedgerEntry[] {
  const events = engine.onOrder(makeOnOrderContext());
  return events.map((e) =>
    commissionEventToEntry(e, {
      merchantId: "merch_1",
      status: "approved",
      availableAt: new Date("2026-06-15T00:00:00Z"),
      now,
    }),
  );
}

describe("ledger balances", () => {
  it("derives pending / available / on-hold / paid balances", () => {
    const entries: LedgerEntry[] = [
      { ...entriesFromOrder()[0]!, status: "pending", availableAt: null },
    ];
    const before = computeBalances(entries, now).get("USD")!;
    expect(before.pendingCents).toBe(2000);
    expect(before.availableCents).toBe(0);

    const approvedOnHold = entriesFromOrder(); // available 2026-06-15
    const onHold = computeBalances(approvedOnHold, new Date("2026-06-10T00:00:00Z")).get("USD")!;
    expect(onHold.onHoldCents).toBe(2000);
    expect(onHold.availableCents).toBe(0);

    const available = computeBalances(approvedOnHold, new Date("2026-06-20T00:00:00Z")).get("USD")!;
    expect(available.availableCents).toBe(2000);
    expect(available.onHoldCents).toBe(0);
  });
});

describe("ledger reversals (clawback)", () => {
  it("reversing an un-paid entry marks the original reversed and excludes it from balances", () => {
    const original = entriesFromOrder()[0]!; // approved, $20
    const reversalEvents = engine.onReversal({
      order: makeOnOrderContext().order,
      originalEntries: [original],
      reason: "refund",
      now,
    });
    expect(reversalEvents).toHaveLength(1);

    const { reversalEntry, originalNewStatus } = applyReversal(original, reversalEvents[0]!, {
      merchantId: "merch_1",
      now,
    });
    expect(originalNewStatus).toBe("reversed");
    expect(reversalEntry.status).toBe("reversed");
    expect(reversalEntry.amountCents).toBe(-2000);

    const updatedOriginal = { ...original, status: originalNewStatus };
    const balances = computeBalances([updatedOriginal, reversalEntry], new Date("2026-06-20T00:00:00Z")).get("USD")!;
    expect(balances.availableCents).toBe(0); // fully reversed, nets to zero
    expect(balances.reversedCents).toBe(2000);
  });

  it("reversing an already-PAID entry creates negative-balance exposure", () => {
    const paid: LedgerEntry = { ...entriesFromOrder()[0]!, status: "paid", availableAt: null };
    const reversalEvent = engine.onReversal({
      order: makeOnOrderContext().order,
      originalEntries: [paid],
      reason: "refund after payout",
      now,
    })[0]!;

    const { reversalEntry, originalNewStatus } = applyReversal(paid, reversalEvent, { merchantId: "merch_1", now });
    expect(originalNewStatus).toBe("paid"); // cannot un-pay
    expect(reversalEntry.status).toBe("approved"); // negative, nets against balance

    const balances = computeBalances([{ ...paid }, reversalEntry], new Date("2026-06-20T00:00:00Z")).get("USD")!;
    expect(balances.paidCents).toBe(2000);
    expect(balances.availableCents).toBe(-2000); // owes it back
  });
});
