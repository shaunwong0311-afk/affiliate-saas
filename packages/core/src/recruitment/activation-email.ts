import type { Offer } from "../types/program.js";
import type { CommissionTermsOverride } from "../types/identity.js";
import { formatMoney } from "../money.js";

/**
 * Activation-optimized welcome/invite email (OUTREACH-SPEC §16 #4+#9). The single
 * highest-ROI moment in recruitment is the seconds AFTER a "yes": the recruit is
 * warm, and every extra step before their first share bleeds activation. Industry
 * data: pre-generating the tracking link + a personal code and handing them a ONE
 * quick-win action lifts activation ~20% over a bare "you're approved, log in".
 *
 * This module is the PURE copy builder — it renders deterministic text from already
 * -resolved facts (no I/O, no invented numbers). The API service resolves the facts
 * (signs the magic link, mints the code, reads the real commission) and sends it.
 *
 * HONESTY: every claimed number is real. The commission line is only present when we
 * read it off the offer; the fast-start bonus is only present when the merchant has
 * configured a genuine first-sale Bonus. The personal code is framed as an ATTRIBUTION
 * code (credit follows it at checkout / in DMs / on a podcast — a real capability),
 * never as a store discount unless one is actually wired.
 */
export interface ActivationEmailInput {
  affiliateName: string;
  merchantName: string;
  /** One-click passwordless portal sign-in (short-circuits the login step entirely). */
  magicLink: string;
  /** Where to request a fresh link if the magic one expired (no dead end). */
  portalUrl: string;
  /** Site-wide default tracking link, pre-generated. Null when the program has no offer yet. */
  trackingUrl: string | null;
  /** Personal attribution code — earns credit even where a link can't follow the buyer. */
  personalCode: string | null;
  /** Commission clarity, one line, e.g. "You earn 15% on every sale." Null when unknown. */
  commissionLine: string | null;
  /** Human-readable fast-start deadline, e.g. "July 15". */
  fastStartDeadline: string;
  /** Real first-sale bonus copy — ONLY when the merchant configured a genuine bonus. */
  fastStartBonus: string | null;
  termsUrl?: string | null;
}

export interface BuiltEmail {
  subject: string;
  text: string;
}

/** Render the plain-text activation email. Deterministic; safe to snapshot. */
export function buildActivationEmail(input: ActivationEmailInput): BuiltEmail {
  const subject = input.fastStartBonus
    ? `You're in — earn your ${input.merchantName} fast-start bonus`
    : `You're in — start earning with ${input.merchantName}`;

  const lines: string[] = [];
  lines.push(`Hi ${input.affiliateName},`);
  lines.push("");
  lines.push(`You're approved for the ${input.merchantName} affiliate program — welcome aboard.`);
  lines.push("");

  // THE one quick-win CTA: one click, no password, lands them ready to share.
  lines.push("Start in one click (no password needed):");
  lines.push(input.magicLink);
  lines.push("");

  // Everything they need to make the first share is already in this email.
  if (input.trackingUrl || input.personalCode) {
    lines.push("Your tools are ready — share these anywhere:");
    if (input.trackingUrl) lines.push(`  • Your tracking link:  ${input.trackingUrl}`);
    if (input.personalCode) {
      lines.push(`  • Your personal code:  ${input.personalCode}`);
      lines.push("    (credit follows your code at checkout, in DMs, or read aloud on a podcast —");
      lines.push("     even when a link can't be clicked)");
    }
    lines.push("");
  }

  if (input.commissionLine) {
    lines.push(input.commissionLine);
    lines.push("");
  }

  // Fast-start: a concrete goal + deadline. Bonus copy only when it's a real reward.
  if (input.fastStartBonus) {
    lines.push(`Fast-start: ${input.fastStartBonus} Make your first sale by ${input.fastStartDeadline}.`);
  } else {
    lines.push(`Fast-start goal: land your first sale by ${input.fastStartDeadline} — the sooner you share, the sooner you earn.`);
  }
  lines.push("");

  lines.push(`Quickest win: drop your link in the bio or post you already had planned — no new content needed.`);
  lines.push("");

  lines.push(`If the sign-in link above ever expires, request a fresh one here: ${input.portalUrl}`);
  if (input.termsUrl) lines.push(`Program terms: ${input.termsUrl}`);
  lines.push("");
  lines.push(`— The ${input.merchantName} team`);

  return { subject, text: lines.join("\n") };
}

/**
 * One-line, honest commission statement from the offer (applying any per-relationship
 * override). Returns null when we genuinely can't state it. Percentage → "You earn 15%
 * on every sale."; flat → "You earn 12.00 USD per sale."
 */
export function commissionLineFromOffer(offer: Offer | null | undefined, override?: CommissionTermsOverride | null): string | null {
  if (!offer) return null;
  if (override?.rate != null) return `You earn ${formatRate(override.rate)} on every sale.`;
  if (override?.flatAmountCents != null) return `You earn ${formatMoney({ amountCents: override.flatAmountCents, currency: offer.currency })} per sale.`;
  if (offer.payoutType === "percentage") return `You earn ${formatRate(offer.payoutValue)} on every sale.`;
  if (offer.payoutType === "flat") return `You earn ${formatMoney({ amountCents: offer.payoutValue, currency: offer.currency })} per sale.`;
  return null;
}

/**
 * Real first-sale bonus copy, or null. Only returns text when the offer carries an
 * actual `first_sale` Bonus — we never promise a bonus the merchant didn't configure.
 */
export function firstSaleBonusText(offer: Offer | null | undefined): string | null {
  const bonus = offer?.bonuses?.find((b) => b.triggerType === "first_sale" && b.amountCents > 0);
  if (!bonus) return null;
  return `earn a ${formatMoney({ amountCents: bonus.amountCents, currency: offer!.currency })} bonus on your first sale.`;
}

/** Decimal rate → percent string, trimming trailing zeros ("0.15" → "15%", "0.125" → "12.5%"). */
function formatRate(rate: number): string {
  const pct = rate * 100;
  return `${Number.isInteger(pct) ? pct.toString() : pct.toFixed(1)}%`;
}
