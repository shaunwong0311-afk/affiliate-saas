import type {
  MerchantRailCredentialSource,
  MerchantRailCredentials,
  PayoutRail,
  PayoutRailFactory,
  PayoutRequest,
  PayoutResult,
  ResolvedRail,
} from "./ports.js";

/**
 * Payout orchestration without custody (Section 4). The platform computes, approves and
 * batches; money never passes through it. A payout leaves in one of two ways:
 *
 *  - MANUAL (the default, and the only way for a merchant who has connected nothing): the
 *    merchant pays from their own PayPal/Wise/bank account — helped by an export file —
 *    and marks each payout paid or failed;
 *  - AUTOMATED, through a rail the MERCHANT connected with their own credentials.
 *
 * There are no platform-wide rail credentials, and this module is built so that there
 * cannot be: a rail instance is bound to one merchant, the registry only builds rails from
 * a merchant's own connection, and nothing accepts a ready-made rail for everyone.
 */

export class NotConfiguredError extends Error {
  constructor(rail: string) {
    super(`${rail} rail is not configured (no HTTP client/credentials supplied)`);
    this.name = "NotConfiguredError";
  }
}

/** A rail was asked to act for a merchant other than the one whose credentials it holds. */
export class RailCredentialScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RailCredentialScopeError";
  }
}

/** Credentials must name the merchant and the rail they belong to, and carry the fields the rail needs. */
function bindToMerchant(rail: string, credentials: MerchantRailCredentials | undefined, required: string[]): string {
  if (!credentials || typeof credentials.merchantId !== "string" || credentials.merchantId === "") {
    throw new RailCredentialScopeError(`${rail} rail needs the credentials of ONE merchant's own ${rail} connection; platform-wide credentials are not supported`);
  }
  if (credentials.rail !== rail) {
    throw new RailCredentialScopeError(`credentials for "${credentials.rail}" cannot be used for the ${rail} rail`);
  }
  for (const field of required) {
    if (!credentials.secret?.[field]) throw new NotConfiguredError(`${rail} (merchant connection is missing "${field}")`);
  }
  return credentials.merchantId;
}

function assertOwnPayout(rail: PayoutRail, request: PayoutRequest): void {
  if (request.merchantId !== rail.merchantId) {
    throw new RailCredentialScopeError(
      `${rail.rail} rail is connected for merchant ${rail.merchantId} and cannot pay out for merchant ${request.merchantId}`,
    );
  }
}

/**
 * A deterministic mock so payout flows run end-to-end in dev/test. It records a payout as
 * paid WITHOUT moving money, so it must never exist in production — the registry only
 * hands it out when told the environment is not production.
 */
export class MockPayoutRail implements PayoutRail {
  readonly rail = "mock";
  readonly merchantId = null;
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
 * Stripe Connect rail (Section 4 / 11) — an UNWIRED adapter: nothing constructs it yet.
 * Real request shape shown; it needs an HTTP client and ONE merchant's own Stripe secret
 * (`secret.apiKey`). Disbursement is a Transfer to the affiliate's connected account.
 */
export class StripeConnectRail implements PayoutRail {
  readonly rail = "stripe";
  readonly merchantId: string;
  constructor(private readonly opts: { credentials: MerchantRailCredentials; http?: HttpClient }) {
    this.merchantId = bindToMerchant(this.rail, opts.credentials, ["apiKey"]);
  }

  async disburse(request: PayoutRequest): Promise<PayoutResult> {
    assertOwnPayout(this, request);
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
        Authorization: `Bearer ${this.opts.credentials.secret["apiKey"]}`,
        "Idempotency-Key": request.idempotencyKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    );
    if (res.status >= 200 && res.status < 300) {
      return { payoutId: request.payoutId, status: "paid", railReference: res.json.id, failureReason: null };
    }
    // A 4xx is Stripe refusing the transfer. Anything else (5xx, a proxy error) may or may
    // not have gone through — that is an unknown outcome, not a failure.
    if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 429) {
      return { payoutId: request.payoutId, status: "failed", railReference: null, failureReason: res.json?.error?.message ?? "stripe error" };
    }
    throw new Error(`stripe answered HTTP ${res.status}; the transfer may or may not have been made`);
  }

  async verifyAccount(accountRef: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.opts.http) throw new NotConfiguredError(this.rail);
    return { ok: accountRef.startsWith("acct_") };
  }
}

/** PayPal Payouts rail — UNWIRED skeleton with the real request shape. Needs one merchant's own client id + secret. */
export class PayPalPayoutsRail implements PayoutRail {
  readonly rail = "paypal";
  readonly merchantId: string;
  constructor(private readonly opts: { credentials: MerchantRailCredentials; http?: HttpClient }) {
    this.merchantId = bindToMerchant(this.rail, opts.credentials, ["clientId", "clientSecret"]);
  }

  async disburse(request: PayoutRequest): Promise<PayoutResult> {
    assertOwnPayout(this, request);
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
    if (res.status < 300) {
      return { payoutId: request.payoutId, status: "processing", railReference: res.json.batch_header?.payout_batch_id, failureReason: null };
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 429) {
      return { payoutId: request.payoutId, status: "failed", railReference: null, failureReason: "paypal error" };
    }
    throw new Error(`paypal answered HTTP ${res.status}; the payout may or may not have been created`);
  }

  async verifyAccount(accountRef: string): Promise<{ ok: boolean; reason?: string }> {
    return { ok: /@/.test(accountRef) };
  }
}

/** Wise rail — UNWIRED skeleton. Needs one merchant's own API token. */
export class WiseRail implements PayoutRail {
  readonly rail = "wise";
  readonly merchantId: string;
  constructor(private readonly opts: { credentials: MerchantRailCredentials; http?: HttpClient }) {
    this.merchantId = bindToMerchant(this.rail, opts.credentials, ["apiKey"]);
  }
  async disburse(request: PayoutRequest): Promise<PayoutResult> {
    assertOwnPayout(this, request);
    throw new NotConfiguredError(this.rail);
  }
  async verifyAccount(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
}

export interface PayoutRailRegistryOptions {
  /**
   * Whether the mock rail exists. It marks payouts paid with no money moved, so pass true
   * ONLY outside production. Default false: a registry built without options has no mock.
   */
  allowMock?: boolean;
  /** Where a merchant's own rail connection is looked up. Without one, every payout is manual. */
  credentials?: MerchantRailCredentialSource;
}

/**
 * Decides, per merchant and payout method, how a payout leaves. There is deliberately no
 * way to register a ready-made rail: an automated rail exists only as a factory that is
 * handed ONE merchant's own credentials at the moment a payout of theirs is approved.
 */
export class PayoutRailRegistry {
  private readonly factories = new Map<string, PayoutRailFactory>();
  private readonly mockRail: MockPayoutRail | null;
  private readonly credentials: MerchantRailCredentialSource | null;

  constructor(opts: PayoutRailRegistryOptions = {}) {
    this.mockRail = opts.allowMock === true ? new MockPayoutRail() : null;
    this.credentials = opts.credentials ?? null;
  }

  /** The mock rail when it exists (dev/test) — lets a test see what was "sent". */
  get mock(): MockPayoutRail | null {
    return this.mockRail;
  }

  /** Teach the registry how to build `rail` from one merchant's own credentials. */
  registerFactory(rail: string, factory: PayoutRailFactory): void {
    const name = rail.trim().toLowerCase();
    if (name === "mock") throw new Error("the mock rail is fixed: it exists outside production or not at all");
    this.factories.set(name, factory);
  }

  /**
   * How a payout by `method` leaves for THIS merchant:
   *  - `mock`: the mock rail outside production; manual in production (never "paid" by a stub);
   *  - a rail the merchant has connected with their own credentials: that rail, bound to them;
   *  - anything else: manual — the merchant pays from their own account.
   */
  async resolveRail(merchant: { id: string }, method: string): Promise<ResolvedRail> {
    const rail = method.trim().toLowerCase();
    if (rail === "mock") {
      return this.mockRail
        ? { mode: "automated", rail: this.mockRail }
        : { mode: "manual", reason: "the mock rail does not exist in production" };
    }
    const factory = this.factories.get(rail);
    if (!factory || !this.credentials) {
      return { mode: "manual", reason: `no automated ${rail || "payout"} rail is available — the merchant pays from their own account` };
    }
    const credentials = await this.credentials(merchant.id, rail);
    if (!credentials) return { mode: "manual", reason: `the merchant has not connected their own ${rail} account` };
    if (credentials.merchantId !== merchant.id || credentials.rail !== rail) {
      throw new RailCredentialScopeError(`refusing ${rail} credentials that belong to ${credentials.merchantId}/${credentials.rail} for merchant ${merchant.id}`);
    }
    const built = factory(credentials);
    if (built.merchantId !== merchant.id) {
      throw new RailCredentialScopeError(`the ${rail} rail built for merchant ${merchant.id} is bound to ${String(built.merchantId)}`);
    }
    return { mode: "automated", rail: built };
  }
}
