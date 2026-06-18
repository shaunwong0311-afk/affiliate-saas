import { describe, it, expect } from "vitest";
import { normalizeOrder, PostbackVerificationError } from "../src/index.js";
import { signPostback, type PostbackPayload } from "@affiliate/core";

describe("order normalizers", () => {
  it("normalizes a Shopify order", () => {
    const raw = {
      id: 123,
      total_price: "120.00",
      subtotal_price: "100.00",
      total_discounts: "10.00",
      total_tax: "8.00",
      currency: "USD",
      created_at: "2026-06-01T00:00:00Z",
      customer: { id: 9, orders_count: 1 },
      discount_codes: [{ code: "SAVE10" }],
      line_items: [{ sku: "WIDGET", product_type: "widgets", quantity: 2, price: "50.00" }],
      note_attributes: [{ name: "click_id", value: "click_abc" }],
    };
    const result = normalizeOrder("shopify", { merchantId: "m1", raw })!;
    expect(result.order.amountCents).toBe(12_000);
    expect(result.order.discountCents).toBe(1_000);
    expect(result.order.couponCodes).toEqual(["SAVE10"]);
    expect(result.order.isNewCustomer).toBe(true);
    expect(result.clickId).toBe("click_abc");
    expect(result.order.txnId).toBe("shopify_123");
  });

  it("normalizes a Stripe rebill invoice", () => {
    const event = {
      type: "invoice.paid",
      data: { object: { id: "in_1", amount_paid: 2999, currency: "usd", billing_reason: "subscription_cycle", metadata: { click_id: "c1" } } },
    };
    const result = normalizeOrder("stripe", { merchantId: "m1", raw: event })!;
    expect(result.order.amountCents).toBe(2999);
    expect(result.order.isRebill).toBe(true);
    expect(result.clickId).toBe("c1");
  });

  it("ignores non-order Stripe events", () => {
    const event = { type: "customer.created", data: { object: { id: "cus_1" } } };
    expect(normalizeOrder("stripe", { merchantId: "m1", raw: event })).toBeNull();
  });

  it("accepts a correctly signed S2S postback", () => {
    const payload: PostbackPayload = {
      merchantId: "m1", txnId: "t1", amountCents: 5000, currency: "USD",
      clickId: "c1", couponCodes: [], customerRef: "cust1", ts: Math.floor(Date.now() / 1000),
    };
    const signature = signPostback(payload, "secret");
    const result = normalizeOrder("s2s", { merchantId: "m1", raw: payload, signature, secret: "secret" })!;
    expect(result.order.amountCents).toBe(5000);
    expect(result.clickId).toBe("c1");
  });

  it("rejects a forged S2S postback", () => {
    const payload: PostbackPayload = {
      merchantId: "m1", txnId: "t1", amountCents: 5000, currency: "USD",
      clickId: null, couponCodes: [], customerRef: null, ts: Math.floor(Date.now() / 1000),
    };
    expect(() => normalizeOrder("s2s", { merchantId: "m1", raw: payload, signature: "deadbeef", secret: "secret" })).toThrow(
      PostbackVerificationError,
    );
  });
});
