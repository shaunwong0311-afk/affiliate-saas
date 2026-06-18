import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed server-to-server postback (Section 6). The robust conversion path: the
 * merchant's server HMAC-signs the conversion payload with a per-merchant secret.
 * An open or unsigned endpoint is the classic way these systems get drained by
 * forged conversions, so verification is mandatory and constant-time.
 */

export interface PostbackPayload {
  merchantId: string;
  txnId: string; // merchant-supplied idempotency key (dedup)
  amountCents: number;
  currency: string;
  clickId?: string | null;
  couponCodes?: string[];
  customerRef?: string | null;
  /** Unix seconds; rejected if too old (replay protection). */
  ts: number;
}

/** Canonical, order-independent serialization so both sides sign the same bytes. */
export function canonicalize(payload: PostbackPayload): string {
  const ordered: Record<string, unknown> = {
    amountCents: payload.amountCents,
    clickId: payload.clickId ?? null,
    couponCodes: (payload.couponCodes ?? []).slice().sort(),
    currency: payload.currency.toUpperCase(),
    customerRef: payload.customerRef ?? null,
    merchantId: payload.merchantId,
    ts: payload.ts,
    txnId: payload.txnId,
  };
  return JSON.stringify(ordered);
}

export function signPostback(payload: PostbackPayload, secret: string): string {
  return createHmac("sha256", secret).update(canonicalize(payload)).digest("hex");
}

export interface VerifyOptions {
  /** Max age in seconds before a postback is rejected as a replay (default 5 min). */
  maxSkewSeconds?: number;
  nowSeconds?: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "bad_signature" | "expired" | "future_timestamp" };

export function verifyPostback(
  payload: PostbackPayload,
  signature: string,
  secret: string,
  opts: VerifyOptions = {},
): VerifyResult {
  const maxSkew = opts.maxSkewSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (payload.ts > now + 60) return { ok: false, reason: "future_timestamp" };
  if (now - payload.ts > maxSkew) return { ok: false, reason: "expired" };

  const expected = signPostback(payload, secret);
  if (!constantTimeEqualHex(expected, signature)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
