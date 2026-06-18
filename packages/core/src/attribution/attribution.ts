import type { Id } from "../types/common.js";
import type { Attribution, Click, Order } from "../types/orders.js";
import type { AffiliateCode, Offer } from "../types/program.js";
import type { AffiliateRelationship } from "../types/identity.js";

/**
 * Link-vs-code precedence (Section 7). Configured per program.
 *  - `link_first`: deterministic click wins; code only when no click.
 *  - `code_first`: an explicitly-used code wins; click only when no code.
 *  - `last_touch`: whichever touch is most recent — a code used at checkout is
 *    treated as the latest touch, so it beats an older click.
 */
export type AttributionPriority = "link_first" | "code_first" | "last_touch";

export interface CodeMatch {
  code: AffiliateCode;
  relationship: AffiliateRelationship;
}

export interface AttributionInputs {
  order: Order;
  /** click_id that rode through the funnel via the postback (deterministic match). */
  clickIdFromPostback?: Id | null;
  /** The click row for that click_id, if found (already validated to belong to order's merchant). */
  postbackClick?: Click | null;
  /** Recent clicks for this cookie/customer, for last-click-within-window fallback. */
  candidateClicks: Click[];
  /** Codes from the order's coupons that resolve to affiliate codes. */
  matchedCodes: CodeMatch[];
  /** Offer lookup for per-offer attribution windows. */
  offersById: Map<Id, Offer>;
  /** Resolve the relationship (role + sponsor) for a click's affiliate+offer. */
  lookupRelationship: (affiliateId: Id, offerId: Id) => AffiliateRelationship | null;
  priority: AttributionPriority;
  now: Date;
}

export interface AttributionResult {
  attribution: Attribution | null;
  reason: string;
}

interface LinkCandidate {
  click: Click;
  relationship: AffiliateRelationship;
  ts: number;
}

interface CodeCandidate {
  match: CodeMatch;
  ts: number;
}

export function resolveAttribution(inputs: AttributionInputs): AttributionResult {
  const link = resolveLinkCandidate(inputs);
  const code = resolveCodeCandidate(inputs);

  if (!link && !code) {
    return { attribution: null, reason: "no link or code attribution found" };
  }

  let chosen: "link" | "code";
  switch (inputs.priority) {
    case "link_first":
      chosen = link ? "link" : "code";
      break;
    case "code_first":
      chosen = code ? "code" : "link";
      break;
    case "last_touch":
      if (link && code) chosen = code.ts >= link.ts ? "code" : "link";
      else chosen = link ? "link" : "code";
      break;
  }

  if (chosen === "link" && link) {
    return {
      attribution: {
        affiliateId: link.click.affiliateId,
        offerId: link.click.offerId,
        mechanism: "link",
        clickId: link.click.clickId,
        codeId: null,
        relationshipId: link.relationship.id,
        sponsorAffiliateId: link.relationship.sponsorAffiliateId,
      },
      reason: inputs.clickIdFromPostback ? "deterministic click_id match" : "last-click within window",
    };
  }

  if (chosen === "code" && code) {
    const rel = code.match.relationship;
    return {
      attribution: {
        affiliateId: rel.affiliateId,
        offerId: firstActiveOfferId(inputs) ?? rel.programId,
        mechanism: "code",
        clickId: null,
        codeId: code.match.code.id,
        relationshipId: rel.id,
        sponsorAffiliateId: rel.sponsorAffiliateId,
      },
      reason: `code attribution (${code.match.code.kind})`,
    };
  }

  return { attribution: null, reason: "no candidate after priority resolution" };
}

function resolveLinkCandidate(inputs: AttributionInputs): LinkCandidate | null {
  const orderTs = new Date(inputs.order.ts).getTime();

  // 1) Deterministic: explicit click_id from the postback.
  if (inputs.postbackClick) {
    const c = inputs.postbackClick;
    if (withinWindow(c, orderTs, inputs.offersById)) {
      const rel = inputs.lookupRelationship(c.affiliateId, c.offerId);
      if (rel) return { click: c, relationship: rel, ts: new Date(c.ts).getTime() };
    }
  }

  // 2) Fallback: last click within the offer window from the cookie's candidates.
  const eligible = inputs.candidateClicks
    .filter((c) => withinWindow(c, orderTs, inputs.offersById))
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  for (const c of eligible) {
    const rel = inputs.lookupRelationship(c.affiliateId, c.offerId);
    if (rel) return { click: c, relationship: rel, ts: new Date(c.ts).getTime() };
  }

  return null;
}

function resolveCodeCandidate(inputs: AttributionInputs): CodeCandidate | null {
  const orderTs = new Date(inputs.order.ts).getTime();
  for (const match of inputs.matchedCodes) {
    const code = match.code;
    if (code.expiresAt && new Date(code.expiresAt).getTime() < orderTs) continue;
    if (code.usageCap != null && code.usageCount >= code.usageCap) continue;
    if (match.relationship.status !== "active") continue;
    return { match, ts: orderTs }; // a code used at checkout is "touched" at order time
  }
  return null;
}

function withinWindow(click: Click, orderTs: number, offersById: Map<Id, Offer>): boolean {
  const offer = offersById.get(click.offerId);
  const windowDays = offer?.windowDays ?? 30;
  const clickTs = new Date(click.ts).getTime();
  // Compare at second precision: postback timestamps are Unix seconds, so a click
  // in the same second as the order must not be disqualified by sub-second jitter.
  if (Math.floor(clickTs / 1000) > Math.floor(orderTs / 1000)) return false;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return orderTs - clickTs <= windowMs;
}

function firstActiveOfferId(inputs: AttributionInputs): Id | null {
  for (const offer of inputs.offersById.values()) {
    if (offer.status === "active") return offer.id;
  }
  return inputs.offersById.size > 0 ? [...inputs.offersById.values()][0]!.id : null;
}
