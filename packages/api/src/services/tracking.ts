import { uuidv7, newId, type Click } from "@affiliate/core";
import { normalizeOrder, type IngestionInput } from "@affiliate/integrations";
import type { AppContext } from "../context.js";
import { ingestNormalizedOrder, type IngestResult } from "./conversion-pipeline.js";

/**
 * Tracking capture used by both the edge service and the API. The redirect hot
 * path mints the click_id and 302s immediately (tracking-edge package); the click
 * record is written asynchronously here so it never blocks the redirect.
 */

export interface ClickCapture {
  merchantId: string;
  affiliateId: string;
  offerId: string;
  ip?: string | null;
  ua?: string | null;
  landingUrl?: string | null;
  sub1?: string;
  sub2?: string;
  sub3?: string;
  sub4?: string;
  sub5?: string;
}

export function mintClickId(now = Date.now()): string {
  return uuidv7(now);
}

export async function writeClick(ctx: AppContext, clickId: string, capture: ClickCapture): Promise<Click> {
  const click: Click = {
    clickId,
    merchantId: capture.merchantId,
    affiliateId: capture.affiliateId,
    offerId: capture.offerId,
    ts: ctx.clock.now().toISOString(),
    ip: capture.ip ?? null,
    ua: capture.ua ?? null,
    landingUrl: capture.landingUrl ?? null,
    ...(capture.sub1 !== undefined ? { sub1: capture.sub1 } : {}),
    ...(capture.sub2 !== undefined ? { sub2: capture.sub2 } : {}),
    ...(capture.sub3 !== undefined ? { sub3: capture.sub3 } : {}),
    ...(capture.sub4 !== undefined ? { sub4: capture.sub4 } : {}),
    ...(capture.sub5 !== undefined ? { sub5: capture.sub5 } : {}),
  };
  return ctx.db.clicks.insert(click);
}

/** Resolve an offer's tracking code → affiliate + offer (encoded in the link). */
export async function resolveTrackingCode(ctx: AppContext, code: string): Promise<{ merchantId: string; affiliateId: string; offerId: string } | null> {
  // Link codes are encoded as `<affiliateShort>-<offerShort>`; for the demo we
  // store a direct lookup table via affiliate_codes of kind 'referral' that double
  // as link codes, or fall back to decoding ids joined by '.'.
  const [affiliateId, offerId] = code.split(".");
  if (affiliateId && offerId) {
    const offer = await ctx.db.offers.get(offerId);
    if (offer) return { merchantId: offer.merchantId, affiliateId, offerId };
  }
  return null;
}

/** Entry point for inbound order events from any source. */
export async function ingestOrder(ctx: AppContext, source: string, input: IngestionInput): Promise<IngestResult> {
  const normalized = normalizeOrder(source, input);
  if (!normalized) {
    return { status: "unattributed", orderId: "", ledgerEntryIds: [], reason: "payload was not an order event" };
  }
  return ingestNormalizedOrder(ctx, normalized);
}

export { newId };
