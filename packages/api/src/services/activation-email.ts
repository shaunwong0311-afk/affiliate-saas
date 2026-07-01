import { newId, newCode, buildActivationEmail, commissionLineFromOffer, firstSaleBonusText } from "@affiliate/core";
import type { AffiliateCode, Offer } from "@affiliate/core";
import { linkCode } from "@affiliate/tracking-edge";
import { signJwt } from "../auth/jwt.js";
import { writeAudit } from "./audit.js";
import type { AppContext } from "../context.js";

/** Welcome-link lifetime — long enough that the recruit can open it hours/days later. */
const MAGIC_TTL_SECONDS = 7 * 24 * 3600;
/** Fast-start window (days) — matches the activation "fast-start" metric. */
const FAST_START_DAYS = 14;
const ACTIVATION_FROM = "no-reply@vantage.dev";

export interface ActivationEmailResult {
  sent: boolean;
  reason?: string;
}

/**
 * Send the activation-optimized welcome email to a newly-active affiliate (OUTREACH-SPEC
 * §16 #4+#9). Resolves the real facts — a passwordless magic link, the pre-generated
 * site-wide tracking link, a personal attribution code, the actual commission line, and a
 * real first-sale bonus when one exists — then renders + sends via the transactional ESP
 * (never the box IP). IDEMPOTENT: stamps `activationEmailSentAt` and never re-sends. Called
 * from every path that turns a relationship active (approve, auto-apply, inbound join,
 * prospect conversion); safe to call redundantly.
 */
export async function sendActivationEmail(
  ctx: AppContext,
  relationshipId: string,
  opts: { force?: boolean } = {},
): Promise<ActivationEmailResult> {
  const rel = await ctx.db.relationships.get(relationshipId);
  if (!rel) return { sent: false, reason: "relationship not found" };
  if (rel.status !== "active") return { sent: false, reason: "relationship not active" };
  if (rel.activationEmailSentAt && !opts.force) return { sent: false, reason: "already sent" };

  const affiliate = await ctx.db.affiliates.get(rel.affiliateId);
  if (!affiliate || !affiliate.primaryEmail) return { sent: false, reason: "affiliate has no email" };
  const merchant = await ctx.db.merchants.get(rel.merchantId);
  if (!merchant) return { sent: false, reason: "merchant not found" };
  const program = await ctx.db.programs.get(rel.programId);

  const appUrl = ctx.config.corsOrigins[0] ?? "http://localhost:5173";

  // 1) Passwordless magic link — the one-click CTA (7-day TTL; the verify route accepts it).
  const magic = signJwt({ sub: affiliate.id, kind: "affiliate_magic", email: affiliate.primaryEmail }, ctx.config.jwtSecret, MAGIC_TTL_SECONDS);
  const magicLink = `${appUrl}/#/portal/verify?token=${magic}`;
  const portalUrl = `${appUrl}/#/portal`;

  // 2) Site-wide default tracking link — the program's first active offer (deterministic code).
  const offers = await ctx.db.offers.find((o) => o.programId === rel.programId && o.status === "active");
  const defaultOffer: Offer | undefined = offers[0];
  const trackingUrl = defaultOffer ? `${ctx.config.trackingBaseUrl}/c/${linkCode(affiliate.id, defaultOffer.id)}` : null;

  // 3) Personal attribution code — find-or-create (referral kind; credit follows it where a
  //    link can't). Not framed as a store discount unless a merchant wires a discountValue.
  const personalCode = await findOrCreatePersonalCode(ctx, affiliate.id, rel.merchantId);

  // 4) Real commission line + real first-sale bonus (null when not configured — never invented).
  const commissionLine = commissionLineFromOffer(defaultOffer, rel.commissionTerms);
  const fastStartBonus = firstSaleBonusText(defaultOffer);

  const deadline = new Date(ctx.clock.now().getTime() + FAST_START_DAYS * 24 * 3600 * 1000);
  const fastStartDeadline = deadline.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

  const email = buildActivationEmail({
    affiliateName: affiliate.name,
    merchantName: merchant.name,
    magicLink,
    portalUrl,
    trackingUrl,
    personalCode: personalCode?.code ?? null,
    commissionLine,
    fastStartDeadline,
    fastStartBonus,
    termsUrl: program?.termsUrl ?? null,
  });

  const res = await ctx.transactionalMailer.send({ from: ACTIVATION_FROM, to: affiliate.primaryEmail, subject: email.subject, text: email.text });
  if (res.status !== "sent") return { sent: false, reason: res.reason ?? "send failed" };

  const now = ctx.clock.now().toISOString();
  await ctx.db.relationships.update(relationshipId, { activationEmailSentAt: now });
  await writeAudit(ctx, {
    merchantId: rel.merchantId,
    actorId: null,
    action: "affiliate.activation_email_sent",
    subjectType: "relationship",
    subjectId: relationshipId,
    metadata: { hasTrackingLink: trackingUrl != null, hasCode: personalCode != null, hasBonus: fastStartBonus != null },
  });
  return { sent: true };
}

/** Find an existing merchant code for the affiliate, or mint a referral (attribution) code. */
async function findOrCreatePersonalCode(ctx: AppContext, affiliateId: string, merchantId: string): Promise<AffiliateCode | null> {
  const existing = await ctx.db.codes.findOne((c) => c.affiliateId === affiliateId && c.merchantId === merchantId);
  if (existing) return existing;
  // Collision-safe mint (codes are unique per merchant).
  let code = newCode(8);
  for (let i = 0; i < 5 && (await ctx.db.codes.findOne((c) => c.merchantId === merchantId && c.code === code)); i++) {
    code = newCode(8);
  }
  const record: AffiliateCode = {
    id: newId("code"),
    affiliateId,
    merchantId,
    code,
    kind: "referral",
    discountValue: null,
    usageCap: null,
    usageCount: 0,
    expiresAt: null,
  };
  await ctx.db.codes.insert(record);
  return record;
}
