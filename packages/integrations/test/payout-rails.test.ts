import { describe, it, expect } from "vitest";
import {
  PayoutRailRegistry,
  MockPayoutRail,
  StripeConnectRail,
  PayPalPayoutsRail,
  WiseRail,
  type MerchantRailCredentials,
  type PayoutRail,
  type PayoutRequest,
} from "../src/index.js";

// AUDIT-2026-10 M15: the mock rail was registered in every environment, and rails were
// platform-global objects — one real key would have paid every merchant's affiliates.
const request = (overrides: Partial<PayoutRequest> = {}): PayoutRequest => ({
  payoutId: "pay_1",
  merchantId: "m1",
  affiliateId: "a1",
  accountRef: "acct_1",
  amountCents: 2_000,
  currency: "USD",
  idempotencyKey: "pay_1:1",
  ...overrides,
});
const credentials = (merchantId: string, rail: string, secret: Record<string, string> = { apiKey: "sk_merchant" }): MerchantRailCredentials => ({ merchantId, rail, secret });

describe("rail resolution is per merchant", () => {
  it("a registry built without options has no mock: a mock payout is manual, never 'paid' by a stub", async () => {
    const production = new PayoutRailRegistry();
    expect(production.mock).toBeNull();
    expect(await production.resolveRail({ id: "m1" }, "mock")).toMatchObject({ mode: "manual" });
    expect(await new PayoutRailRegistry({ allowMock: false }).resolveRail({ id: "m1" }, "mock")).toMatchObject({ mode: "manual" });
  });

  it("outside production the mock rail resolves, whatever the letter case", async () => {
    const dev = new PayoutRailRegistry({ allowMock: true });
    const resolved = await dev.resolveRail({ id: "m1" }, " Mock ");
    expect(resolved.mode).toBe("automated");
    expect(resolved.mode === "automated" && resolved.rail).toBe(dev.mock);
    expect(dev.mock).toBeInstanceOf(MockPayoutRail);
  });

  it("every real method is manual until the MERCHANT has connected their own account", async () => {
    const none = new PayoutRailRegistry({ allowMock: true });
    for (const method of ["paypal", "wise", "stripe", "bank", ""]) {
      expect((await none.resolveRail({ id: "m1" }, method)).mode).toBe("manual");
    }
    // A factory alone is not enough: there are no platform credentials to fall back to.
    none.registerFactory("stripe", (c) => new StripeConnectRail({ credentials: c }));
    expect((await none.resolveRail({ id: "m1" }, "stripe")).mode).toBe("manual");
  });

  it("uses a merchant's own connection for that merchant only", async () => {
    const asked: string[] = [];
    const registry = new PayoutRailRegistry({
      credentials: async (merchantId, rail) => {
        asked.push(`${merchantId}/${rail}`);
        return merchantId === "m1" && rail === "stripe" ? credentials("m1", "stripe") : null;
      },
    });
    registry.registerFactory("Stripe", (c) => new StripeConnectRail({ credentials: c }));
    const mine = await registry.resolveRail({ id: "m1" }, "stripe");
    expect(mine.mode === "automated" && mine.rail.merchantId).toBe("m1");
    expect((await registry.resolveRail({ id: "m2" }, "stripe")).mode).toBe("manual");
    expect(asked).toEqual(["m1/stripe", "m2/stripe"]);
  });

  it("refuses credentials or a rail that belong to a different merchant", async () => {
    const crossed = new PayoutRailRegistry({ credentials: async () => credentials("m-other", "stripe") });
    crossed.registerFactory("stripe", (c) => new StripeConnectRail({ credentials: c }));
    await expect(crossed.resolveRail({ id: "m1" }, "stripe")).rejects.toThrow(/belong to m-other/);

    const shared: PayoutRail = new StripeConnectRail({ credentials: credentials("m-platform", "stripe") });
    const reused = new PayoutRailRegistry({ credentials: async (merchantId) => credentials(merchantId, "stripe") });
    reused.registerFactory("stripe", () => shared); // one instance for everyone
    await expect(reused.resolveRail({ id: "m1" }, "stripe")).rejects.toThrow(/bound to m-platform/);
  });

  it("offers no way to register a ready-made rail, and the mock cannot be replaced", () => {
    const registry = new PayoutRailRegistry({ allowMock: true }) as unknown as Record<string, unknown>;
    expect(registry["register"]).toBeUndefined();
    expect(registry["get"]).toBeUndefined();
    expect(() => new PayoutRailRegistry().registerFactory("mock", () => new MockPayoutRail())).toThrow(/mock rail is fixed/);
  });
});

describe("the real-rail adapters cannot run on platform-wide credentials", () => {
  it("cannot be constructed without one merchant's credentials for that rail", () => {
    expect(() => new StripeConnectRail({} as any)).toThrow(/ONE merchant/);
    expect(() => new StripeConnectRail({ credentials: { rail: "stripe", secret: { apiKey: "sk_platform" } } } as any)).toThrow(/ONE merchant/);
    expect(() => new StripeConnectRail({ credentials: credentials("m1", "paypal") })).toThrow(/cannot be used/);
    expect(() => new StripeConnectRail({ credentials: credentials("m1", "stripe", {}) })).toThrow(/missing "apiKey"/);
    expect(() => new PayPalPayoutsRail({ credentials: credentials("m1", "paypal", { clientId: "id" }) })).toThrow(/missing "clientSecret"/);
    expect(() => new WiseRail({ credentials: undefined as any })).toThrow(/ONE merchant/);
  });

  it("refuse to pay out for any merchant but their own — before any HTTP call", async () => {
    const calls: unknown[] = [];
    const http = { post: async (...args: unknown[]) => (calls.push(args), { status: 200, json: { id: "tr_1" } }) };
    const stripe = new StripeConnectRail({ credentials: credentials("m1", "stripe"), http });
    await expect(stripe.disburse(request({ merchantId: "m2" }))).rejects.toThrow(/cannot pay out for merchant m2/);
    const paypal = new PayPalPayoutsRail({ credentials: credentials("m1", "paypal", { clientId: "id", clientSecret: "s" }), http });
    await expect(paypal.disburse(request({ merchantId: "m2" }))).rejects.toThrow(/cannot pay out/);
    await expect(new WiseRail({ credentials: credentials("m1", "wise") }).disburse(request({ merchantId: "m2" }))).rejects.toThrow(/cannot pay out/);
    expect(calls).toHaveLength(0);

    expect(await stripe.disburse(request())).toMatchObject({ status: "paid", railReference: "tr_1" });
    expect(calls).toHaveLength(1);
    expect((calls[0] as any[])[2].Authorization).toBe("Bearer sk_merchant");
    expect((calls[0] as any[])[2]["Idempotency-Key"]).toBe("pay_1:1");
  });

  it("report a refusal as failed but a server error as unknown (thrown), so a reservation is not released on a maybe", async () => {
    const answering = (status: number) =>
      new StripeConnectRail({ credentials: credentials("m1", "stripe"), http: { post: async () => ({ status, json: { error: { message: "no such destination" } } }) } });
    expect(await answering(400).disburse(request())).toMatchObject({ status: "failed", failureReason: "no such destination" });
    for (const status of [500, 502, 409, 429]) {
      await expect(answering(status).disburse(request()), String(status)).rejects.toThrow(/may or may not/);
    }
  });
});
