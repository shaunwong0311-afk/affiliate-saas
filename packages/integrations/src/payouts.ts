import type { PayoutRail, PayoutRequest, PayoutResult } from "./ports.js";

/**
 * Payout orchestration without custody (Section 4). The platform computes,
 * approves, batches, and triggers disbursement; the rail is the regulated
 * money-mover and owns KYC. Stripe Connect is the first concrete rail; PayPal
 * Payouts and Wise are natural next adapters.
 */

export class NotConfiguredError extends Error {
  constructor(rail: string) {
    super(`${rail} rail is not configured (no HTTP client/credentials supplied)`);
    this.name = "NotConfiguredError";
  }
}

/** Default rail: a deterministic mock so payout flows run end-to-end in dev/test. */
export class MockPayoutRail implements PayoutRail {
  readonly rail = "mock";
  readonly sent: PayoutRequest[] = [];

  async disburse(request: PayoutRequest): Promise<PayoutResult> {
    this.sent.push(request);
    if (request.amountCents <= 0) {
      return { payoutId: request.payoutId, status: "failed", railReference: null, failureReason: "non-positive amount" };
    }
    if (request.accountRef.startsWith("fail_")) {
      return { payoutId: request.payoutId, status: "failed", railReference: null, failureReason: "simulated rail failure" };
    }
    return {
      payoutId: request.payoutId,
      status: "paid",
      railReference: `mock_tr_${request.idempotencyKey}`,
      failureReason: null,
    };
  }

  async verifyAccount(accountRef: string): Promise<{ ok: boolean; reason?: string }> {
    return accountRef.startsWith("fail_") ? { ok: false, reason: "account disabled" } : { ok: true };
  }
}

/** Minimal HTTP surface so real rails need no SDK dependency. */
export interface HttpClient {
  post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: any }>;
}

/**
 * Stripe Connect rail (Section 4 / 11). Real shape shown; requires an HTTP client
 * and the connected account's secret. Disbursement is a Transfer to the
 * affiliate's connected account.
 */
export class StripeConnectRail implements PayoutRail {
  readonly rail = "stripe";
  constructor(
    private readonly opts: { apiKey: string; http?: HttpClient },
  ) {}

  async disburse(request: PayoutRequest): Promise<PayoutResult> {
    if (!this.opts.http) throw new NotConfiguredError(this.rail);
    const res = await this.opts.http.post(
      "https://api.stripe.com/v1/transfers",
      {
        amount: request.amountCents,
        currency: request.currency.toLowerCase(),
        destination: request.accountRef,
        transfer_group: request.payoutId,
      },
      {
        Authorization: `Bearer ${this.opts.apiKey}`,
        "Idempotency-Key": request.idempotencyKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    );
    if (res.status >= 200 && res.status < 300) {
      return { payoutId: request.payoutId, status: "paid", railReference: res.json.id, failureReason: null };
    }
    return { payoutId: request.payoutId, status: "failed", railReference: null, failureReason: res.json?.error?.message ?? "stripe error" };
  }

  async verifyAccount(accountRef: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.opts.http) throw new NotConfiguredError(this.rail);
    return { ok: accountRef.startsWith("acct_") };
  }
}

/** PayPal Payouts rail — skeleton with the real request shape. */
export class PayPalPayoutsRail implements PayoutRail {
  readonly rail = "paypal";
  constructor(private readonly opts: { clientId: string; secret: string; http?: HttpClient }) {}

  async disburse(request: PayoutRequest): Promise<PayoutResult> {
    if (!this.opts.http) throw new NotConfiguredError(this.rail);
    const res = await this.opts.http.post(
      "https://api-m.paypal.com/v1/payments/payouts",
      {
        sender_batch_header: { sender_batch_id: request.idempotencyKey },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: (request.amountCents / 100).toFixed(2), currency: request.currency },
            receiver: request.accountRef,
          },
        ],
      },
      { "Content-Type": "application/json" },
    );
    return res.status < 300
      ? { payoutId: request.payoutId, status: "processing", railReference: res.json.batch_header?.payout_batch_id, failureReason: null }
      : { payoutId: request.payoutId, status: "failed", railReference: null, failureReason: "paypal error" };
  }

  async verifyAccount(accountRef: string): Promise<{ ok: boolean; reason?: string }> {
    return { ok: /@/.test(accountRef) };
  }
}

/** Wise rail — skeleton. */
export class WiseRail implements PayoutRail {
  readonly rail = "wise";
  constructor(private readonly opts: { apiKey: string; http?: HttpClient }) {}
  async disburse(request: PayoutRequest): Promise<PayoutResult> {
    if (!this.opts.http) throw new NotConfiguredError(this.rail);
    void request;
    throw new NotConfiguredError(this.rail);
  }
  async verifyAccount(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
}

export class PayoutRailRegistry {
  private readonly rails = new Map<string, PayoutRail>();
  constructor(rails: PayoutRail[] = [new MockPayoutRail()]) {
    for (const r of rails) this.rails.set(r.rail, r);
  }
  register(rail: PayoutRail): void {
    this.rails.set(rail.rail, rail);
  }
  get(rail: string): PayoutRail {
    const r = this.rails.get(rail) ?? this.rails.get("mock");
    if (!r) throw new Error(`no payout rail "${rail}" and no mock fallback`);
    return r;
  }
}
