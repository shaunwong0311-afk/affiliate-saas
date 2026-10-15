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
  /**
   * The affiliate's own (global) status. A paused or banned affiliate earns nothing, by
   * link or by code. Left out, every affiliate counts as active.
   */
  isAffiliateActive?: (affiliateId: Id) => boolean;
  priority: AttributionPriority;
  /**
   * Precedence per program — it is a program setting, and a merchant can run several. When
   * the link and the code belong to programs that disagree, `last_touch` (the documented
   * default) decides. Programs missing here fall back to `priority`.
   */
  priorityByProgram?: ReadonlyMap<Id, AttributionPriority>;
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

/**
 * Status is enforced here, for both mechanisms: the relationship, the affiliate and the
 * offer must all be active for a touch to earn. (Before, only codes checked the
 * relationship — a banned affiliate kept earning through links, and a paused offer kept
 * paying.)
 */
export function resolveAttribution(inputs: AttributionInputs): AttributionResult {
  const ignored: string[] = [];
  const link = resolveLinkCandidate(inputs, ignored);
  const code = resolveCodeCandidate(inputs, ignored);

  if (!link && !code) {
    const why = ignored.length ? ` (ignored: ${[...new Set(ignored)].join("; ")})` : "";
    return { attribution: null, reason: `no link or code attribution found${why}` };
  }

  let chosen: "link" | "code";
  switch (effectivePriority(inputs, link, code)) {
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
    // Pick an active offer in the RELATIONSHIP's program (not the merchant's first
    // offer) so multi-program merchants attribute the code to the correct program.
    const offerId = offerInProgram(inputs, rel.programId);
    if (!offerId) {
      return { attribution: null, reason: "code matched but no active offer in its program" };
    }
    return {
      attribution: {
        affiliateId: rel.affiliateId,
        offerId,
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

/** The program's precedence — or `last_touch` when two programs are in play and disagree. */
function effectivePriority(inputs: AttributionInputs, link: LinkCandidate | null, code: CodeCandidate | null): AttributionPriority {
  const byProgram = inputs.priorityByProgram;
  if (!byProgram) return inputs.priority;
  const linkProgram = link ? inputs.offersById.get(link.click.offerId)?.programId : undefined;
  const codeProgram = code?.match.relationship.programId;
  const forLink = linkProgram !== undefined ? byProgram.get(linkProgram) : undefined;
  const forCode = codeProgram !== undefined ? byProgram.get(codeProgram) : undefined;
  if (forLink && forCode) return forLink === forCode ? forLink : "last_touch";
  return forLink ?? forCode ?? inputs.priority;
}

const affiliateIsActive = (inputs: AttributionInputs, affiliateId: Id): boolean =>
  inputs.isAffiliateActive ? inputs.isAffiliateActive(affiliateId) : true;

/** The relationship a click may earn through, or null (with the reason noted) when it may not. */
function earningRelationship(inputs: AttributionInputs, click: Click, ignored: string[]): AffiliateRelationship | null {
  const offer = inputs.offersById.get(click.offerId);
  if (!offer) return null;
  if (offer.status !== "active") {
    ignored.push(`click on ${offer.status} offer`);
    return null;
  }
  if (!affiliateIsActive(inputs, click.affiliateId)) {
    ignored.push("click from an affiliate who is not active");
    return null;
  }
  const rel = inputs.lookupRelationship(click.affiliateId, click.offerId);
  if (!rel) return null;
  if (rel.status !== "active") {
    ignored.push(`click from a ${rel.status} relationship`);
    return null;
  }
  return rel;
}

function resolveLinkCandidate(inputs: AttributionInputs, ignored: string[]): LinkCandidate | null {
  const orderTs = new Date(inputs.order.ts).getTime();

  // 1) Deterministic: explicit click_id from the postback.
  if (inputs.postbackClick) {
    const c = inputs.postbackClick;
    if (withinWindow(c, orderTs, inputs.offersById)) {
      const rel = earningRelationship(inputs, c, ignored);
      if (rel) return { click: c, relationship: rel, ts: new Date(c.ts).getTime() };
    }
  }

  // 2) Fallback: last click within the offer window from the cookie's candidates.
  const eligible = inputs.candidateClicks
    .filter((c) => withinWindow(c, orderTs, inputs.offersById))
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  for (const c of eligible) {
    const rel = earningRelationship(inputs, c, ignored);
    if (rel) return { click: c, relationship: rel, ts: new Date(c.ts).getTime() };
  }

  return null;
}

function resolveCodeCandidate(inputs: AttributionInputs, ignored: string[]): CodeCandidate | null {
  const orderTs = new Date(inputs.order.ts).getTime();
  for (const match of inputs.matchedCodes) {
    const code = match.code;
    if (code.expiresAt && new Date(code.expiresAt).getTime() < orderTs) continue;
    if (code.usageCap != null && code.usageCount >= code.usageCap) continue;
    if (match.relationship.status !== "active") {
      ignored.push(`code from a ${match.relationship.status} relationship`);
      continue;
    }
    if (!affiliateIsActive(inputs, match.relationship.affiliateId)) {
      ignored.push("code from an affiliate who is not active");
      continue;
    }
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

/** Select an ACTIVE offer belonging to a specific program (for code attribution). A paused offer pays nothing. */
function offerInProgram(inputs: AttributionInputs, programId: Id): Id | null {
  for (const offer of inputs.offersById.values()) {
    if (offer.programId === programId && offer.status === "active") return offer.id;
  }
  return null;
}
