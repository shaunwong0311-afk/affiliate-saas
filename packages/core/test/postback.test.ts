import { describe, it, expect } from "vitest";
import { signPostback, verifyPostback, type PostbackPayload } from "../src/index.js";

const secret = "whsec_test_merchant_secret";
const nowSeconds = 1_750_000_000;

const payload: PostbackPayload = {
  merchantId: "merch_1",
  txnId: "order-998",
  amountCents: 12_900,
  currency: "usd",
  clickId: "click_1",
  couponCodes: ["SAVE10", "FREESHIP"],
  customerRef: "cust_42",
  ts: nowSeconds,
};

describe("signed postback", () => {
  it("verifies a correctly signed payload", () => {
    const sig = signPostback(payload, secret);
    expect(verifyPostback(payload, sig, secret, { nowSeconds }).ok).toBe(true);
  });

  it("rejects a tampered amount", () => {
    const sig = signPostback(payload, secret);
    const res = verifyPostback({ ...payload, amountCents: 1 }, sig, secret, { nowSeconds });
    expect(res).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("is independent of coupon ordering", () => {
    const sig = signPostback(payload, secret);
    const reordered = { ...payload, couponCodes: ["FREESHIP", "SAVE10"] };
    expect(verifyPostback(reordered, sig, secret, { nowSeconds }).ok).toBe(true);
  });

  it("rejects replays outside the skew window", () => {
    const sig = signPostback(payload, secret);
    const res = verifyPostback(payload, sig, secret, { nowSeconds: nowSeconds + 10_000 });
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects the wrong secret", () => {
    const sig = signPostback(payload, "wrong");
    expect(verifyPostback(payload, sig, secret, { nowSeconds }).ok).toBe(false);
  });
});
