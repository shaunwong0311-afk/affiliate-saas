import { describe, it, expect } from "vitest";
import { signPostback, type PostbackPayload } from "@affiliate/core";
import { normalizeOrder, parsePostbackPayload, hashEmail, InvalidOrderError, PostbackVerificationError } from "../src/index.js";

const SECRET = "s3cret";
const now = () => Math.floor(Date.now() / 1000);
const signed = (overrides: Record<string, unknown> = {}) => {
  const payload = { merchantId: "m1", txnId: "t1", amountCents: 5000, currency: "USD", clickId: "c1", couponCodes: [], customerRef: null, ts: now(), ...overrides };
  let signature = "unsignable";
  try {
    signature = signPostback(payload as PostbackPayload, SECRET);
  } catch {
    // A shape the signer itself cannot serialize — validation has to reject it first.
  }
  return { merchantId: "m1", raw: payload, signature, secret: SECRET };
};

// AUDIT-2026-10 M3: the public postback body was not validated; `amountCents: 1999.5` was
// stored as an order and a conversion before the money code threw.
describe("S2S postback payload is validated before anything else", () => {
  it("rejects fractional, negative, string and missing amounts", () => {
    for (const amountCents of [1999.5, -1, "5000", null, undefined, Number.NaN, 2 ** 60]) {
      expect(() => normalizeOrder("s2s", signed({ amountCents }))).toThrow(InvalidOrderError);
    }
    expect(normalizeOrder("s2s", signed({ amountCents: 0 }))!.order.amountCents).toBe(0);
  });

  it("rejects a malformed currency, timestamp, coupon list or id — as a 400, never a crash", () => {
    const bad: Record<string, unknown>[] = [
      { currency: "US" },
      { currency: "USDX" },
      { currency: 840 },
      { currency: "U$D" },
      { ts: "now" },
      { ts: 1.5 },
      { ts: -5 },
      { couponCodes: "SAVE10" },
      { couponCodes: [1, 2] },
      { clickId: { $ne: null } },
      { customerRef: ["a"] },
      { txnId: "x".repeat(201) },
    ];
    for (const overrides of bad) {
      const err = (() => {
        try {
          normalizeOrder("s2s", signed(overrides));
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err, JSON.stringify(overrides)).toBeInstanceOf(InvalidOrderError);
      expect((err as InvalidOrderError).statusCode).toBe(400);
    }
  });

  it("rejects a body addressed to another merchant, and anything that is not an object", () => {
    expect(() => normalizeOrder("s2s", { ...signed({ merchantId: "m2" }), merchantId: "m1" })).toThrow(/does not match/);
    expect(() => parsePostbackPayload([1, 2])).toThrow(InvalidOrderError);
    expect(() => parsePostbackPayload("txn")).toThrow(InvalidOrderError);
  });

  it("drops unknown fields and still verifies exactly what the sender signed", () => {
    const input = signed({ couponCodes: ["B", "A"], customerRef: "cust_9" });
    const result = normalizeOrder("s2s", { ...input, raw: { ...(input.raw as object), isAdmin: true, amountCentsOverride: 1 } })!;
    expect(result.order).toMatchObject({ amountCents: 5000, currency: "USD", txnId: "t1", couponCodes: ["B", "A"] });
    expect(result.customerRef).toBe("cust_9");
    expect(parsePostbackPayload(input.raw)).not.toHaveProperty("isAdmin");
  });

  it("answers a bad or missing signature with 401", () => {
    const input = signed();
    const forged = (() => {
      try {
        normalizeOrder("s2s", { ...input, signature: "deadbeef" });
      } catch (e) {
        return e as PostbackVerificationError;
      }
    })()!;
    expect(forged).toBeInstanceOf(PostbackVerificationError);
    expect(forged.statusCode).toBe(401);
    // Tampering with a signed field after signing is caught.
    expect(() => normalizeOrder("s2s", { ...input, raw: { ...(input.raw as object), amountCents: 500_000 } })).toThrow(PostbackVerificationError);
  });
});

describe("provider amounts are parsed exactly and refused when they are not numbers", () => {
  const shopify = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    total_price: "93.00",
    subtotal_price: "80.00",
    total_discounts: "20.00",
    total_tax: "8.00",
    total_shipping_price_set: { shop_money: { amount: "5.00" } },
    currency: "USD",
    created_at: "2026-06-01T10:00:00-04:00",
    customer: { id: 9, orders_count: 1 },
    line_items: [{ sku: "W", product_type: "widgets", quantity: 1, price: "100.00" }],
    ...overrides,
  });

  it("converts decimal strings without float error", () => {
    const cents = (total_price: unknown) => normalizeOrder("shopify", { merchantId: "m1", raw: shopify({ total_price, subtotal_price: undefined, total_discounts: undefined, total_tax: undefined, total_shipping_price_set: undefined, line_items: [] }) })!.order.amountCents;
    expect(cents("19.99")).toBe(1999);
    expect(cents("1.005")).toBe(101); // parseFloat("1.005") * 100 = 100.49999999999999 → 100
    expect(cents("0.07")).toBe(7);
    expect(cents("1234567.89")).toBe(123_456_789);
    expect(cents(19.99)).toBe(1999);
    expect(cents("20")).toBe(2000);
    for (const garbage of ["abc", "12,50", "1e3", "NaN", "Infinity", "-5.00"]) {
      expect(() => cents(garbage), garbage).toThrow(InvalidOrderError);
    }
  });

  it("stores the Shopify subtotal BEFORE discounts, so the parts of the order add up", () => {
    const { order } = normalizeOrder("shopify", { merchantId: "m1", raw: shopify() })!;
    expect(order).toMatchObject({ amountCents: 9_300, subtotalCents: 10_000, discountCents: 2_000, taxCents: 800, shippingCents: 500 });
    expect(order.subtotalCents - order.discountCents + order.taxCents + order.shippingCents).toBe(order.amountCents);
    expect(order.ts).toBe("2026-06-01T14:00:00.000Z"); // normalized to UTC
    const explicit = normalizeOrder("shopify", { merchantId: "m1", raw: shopify({ total_line_items_price: "100.00" }) })!.order;
    expect(explicit.subtotalCents).toBe(10_000);
  });

  it("derives a WooCommerce subtotal from the parts instead of using the grand total", () => {
    const raw = { id: 7, total: "93.00", discount_total: "20.00", total_tax: "8.00", shipping_total: "5.00", currency: "USD", customer_id: 0, line_items: [{ sku: "W", quantity: 1, total: "80.00" }] };
    const { order } = normalizeOrder("woocommerce", { merchantId: "m1", raw })!;
    expect(order).toMatchObject({ amountCents: 9_300, subtotalCents: 10_000, discountCents: 2_000 });
  });

  it("rejects an order with an unusable currency or date", () => {
    expect(() => normalizeOrder("shopify", { merchantId: "m1", raw: shopify({ currency: "DOLLARS" }) })).toThrow(InvalidOrderError);
    expect(() => normalizeOrder("shopify", { merchantId: "m1", raw: shopify({ created_at: "yesterday" }) })).toThrow(InvalidOrderError);
    expect(() => normalizeOrder("stripe", { merchantId: "m1", raw: { type: "invoice.paid", data: { object: { id: "in_1", amount_paid: 29.99, currency: "usd" } } } })).toThrow(InvalidOrderError);
  });
});

// AUDIT-2026-10 M12: Customer.emailHash was only ever written as null.
describe("the buyer's email leaves the normalizer only as a hash", () => {
  const expected = hashEmail("Buyer@Example.com ");

  it("hashes case- and whitespace-insensitively", () => {
    expect(expected).toBe(hashEmail("buyer@example.com"));
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is carried by every source that knows the email, and by none that does not", () => {
    const shopify = normalizeOrder("shopify", { merchantId: "m1", raw: { id: 1, total_price: "10.00", currency: "USD", email: "Buyer@Example.com" } })!;
    const woo = normalizeOrder("woocommerce", { merchantId: "m1", raw: { id: 1, total: "10.00", currency: "USD", billing: { email: "buyer@example.com" } } })!;
    const stripe = normalizeOrder("stripe", { merchantId: "m1", raw: { type: "checkout.session.completed", data: { object: { id: "cs_1", amount_total: 1000, currency: "usd", customer_details: { email: "BUYER@example.com" } } } } })!;
    const s2s = normalizeOrder("s2s", signed({ customerRef: "buyer@example.com" }))!;
    for (const n of [shopify, woo, stripe, s2s]) expect(n.customerEmailHash).toBe(expected);
    expect(JSON.stringify([shopify.order, woo.order, stripe.order])).not.toContain("example.com");

    expect(normalizeOrder("s2s", signed({ customerRef: "cust_123" }))!.customerEmailHash).toBeNull();
    expect(normalizeOrder("shopify", { merchantId: "m1", raw: { id: 2, total_price: "10.00", currency: "USD" } })!.customerEmailHash).toBeNull();
  });
});
