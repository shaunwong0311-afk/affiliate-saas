import { applyRate, money, type Money } from "../money.js";
import { isRecruiter, isSeller } from "../types/common.js";
import type {
  CommissionEngine,
  CommissionEvent,
  OnOrderContext,
  OnReversalContext,
  QualifyContext,
  Qualification,
  ReversalEvent,
  RunCycleContext,
} from "./types.js";
import {
  categoryRateFor,
  computeCommissionableBase,
  maxCommissionCents,
  selectRate,
} from "./rules.js";

/**
 * Affiliate engine (first implementation, event-driven; Section 5).
 *
 * A sale fires → apply the offer's rate → optionally walk the sponsor pointer up
 * ONE level for a two-tier override → emit commission events. `runCycle` is a
 * no-op (payout batching lives in the substrate). Shallow and immediate.
 *
 * Pure: no I/O, no clock of its own — everything arrives in the context, so the
 * same inputs always produce the same money events.
 */
export class AffiliateEngine implements CommissionEngine {
  readonly kind = "affiliate";

  onOrder(ctx: OnOrderContext): CommissionEvent[] {
    const { order, offer, relationship } = ctx;
    const events: CommissionEvent[] = [];
    const currency = order.currency;

    const base = computeCommissionableBase(order, offer, {
      isFirstConversionForAffiliate: ctx.isFirstConversionForAffiliate,
    });
    if (!base.eligible) return events; // disqualified: no commission, no override

    const cId = ctx.conversionId;

    // ---- Direct commission (seller earns on their own sale) --------------------
    if (isSeller(relationship.role)) {
      const commission = this.computeDirectCommission(ctx, base.baseCents);
      if (commission.amountCents > 0) {
        events.push({
          type: "commission",
          affiliateId: relationship.affiliateId,
          amount: commission,
          conversionId: cId,
          level: 0,
          reason: commission.amountCents > 0 ? "direct sale commission" : "",
          metadata: { commissionableBaseCents: base.baseCents },
        });
      }

      // ---- Bonuses (milestone / activation) ----------------------------------
      for (const ev of this.computeBonuses(ctx, base.baseCents, cId, currency)) {
        events.push(ev);
      }
    }

    // ---- Recruiter override (walk sponsor pointer ONE level) -------------------
    const overrideEvent = this.computeOverride(ctx, base.baseCents, cId, currency);
    if (overrideEvent) events.push(overrideEvent);

    return events;
  }

  private computeDirectCommission(ctx: OnOrderContext, baseCents: number): Money {
    const { offer, order, relationship } = ctx;
    const currency = order.currency;

    // Flat offers pay a fixed amount, overridable per relationship.
    if (offer.payoutType === "flat") {
      const flat = relationship.commissionTerms?.flatAmountCents ?? offer.payoutValue;
      return capCommission(money(flat, currency), offer);
    }

    // Percentage offers: select effective rate, then apply per category if rules exist.
    const relRate = relationship.commissionTerms?.rate;
    const { rate } = selectRate(offer, ctx.priorVolumeCents, relRate, ctx.now);

    const base = computeCommissionableBase(order, offer, {
      isFirstConversionForAffiliate: ctx.isFirstConversionForAffiliate,
    });

    // If category-specific rates exist, compute per category; otherwise flat rate on base.
    const hasCategoryRates = offer.rules.some((r) => r.kind === "category_rate");
    let amountCents = 0;
    if (hasCategoryRates) {
      for (const [category, catBase] of base.categoryBaseCents) {
        const catRate = categoryRateFor(offer, category) ?? rate;
        amountCents += applyRate(money(catBase, currency), catRate).amountCents;
      }
    } else {
      amountCents = applyRate(money(baseCents, currency), rate).amountCents;
    }

    return capCommission(money(amountCents, currency), offer);
  }

  private computeBonuses(
    ctx: OnOrderContext,
    baseCents: number,
    conversionId: string,
    currency: string,
  ): CommissionEvent[] {
    const out: CommissionEvent[] = [];
    const newVolume = ctx.priorVolumeCents + baseCents;
    const newCount = ctx.priorConversionCount + 1;

    for (const bonus of ctx.offer.bonuses) {
      let award = false;
      switch (bonus.triggerType) {
        case "first_sale":
          award = ctx.isFirstConversionForAffiliate;
          break;
        case "conversion_count":
          // Award on the conversion that crosses the threshold.
          award = ctx.priorConversionCount < bonus.threshold && newCount >= bonus.threshold;
          break;
        case "lifetime_volume":
          award = ctx.priorVolumeCents < bonus.threshold && newVolume >= bonus.threshold;
          break;
      }
      if (award) {
        out.push({
          type: "bonus",
          affiliateId: ctx.relationship.affiliateId,
          amount: money(bonus.amountCents, currency),
          conversionId,
          level: 0,
          reason: `bonus: ${bonus.triggerType} (threshold ${bonus.threshold})`,
          metadata: { bonusId: bonus.id },
        });
      }
    }
    return out;
  }

  /**
   * Two-tier override. Strictly contingent on the recruit's real sale, never the
   * signup. Walks the sponsor pointer exactly one level (maxDepth: 1).
   */
  private computeOverride(
    ctx: OnOrderContext,
    baseCents: number,
    conversionId: string,
    currency: string,
  ): CommissionEvent | null {
    const policy = ctx.offer.overridePolicy;
    const sponsor = ctx.sponsorRelationship;
    if (!policy || !sponsor) return null;

    // The sponsor must currently hold the recruiter role and be active.
    if (!isRecruiter(sponsor.role) || sponsor.status !== "active") return null;

    // Self-referral guard: a sponsor can never override their own sale.
    if (sponsor.affiliateId === ctx.relationship.affiliateId) return null;

    // Trigger gate.
    if (policy.trigger === "first_sale" && !ctx.isFirstSaleUnderSponsor) return null;

    const amount =
      policy.structure === "flat"
        ? money(policy.value, currency)
        : applyRate(money(baseCents, currency), policy.value);

    if (amount.amountCents <= 0) return null;

    return {
      type: "override",
      affiliateId: sponsor.affiliateId,
      amount,
      conversionId,
      level: 1,
      reason: `recruiter override (${policy.structure}, ${policy.trigger})`,
      metadata: { policyId: policy.id, recruitAffiliateId: ctx.relationship.affiliateId },
    };
  }

  /** Affiliate engine has no batch work; payout batching lives in the substrate. */
  runCycle(_ctx: RunCycleContext): CommissionEvent[] {
    return [];
  }

  /**
   * Clawback cascade (Section 4): reverse every non-reversed entry the conversion
   * produced — the direct commission AND the one-level override. For MLM this same
   * pattern walks the full upline; here it is depth-capped at the entries present.
   */
  onReversal(ctx: OnReversalContext): ReversalEvent[] {
    return ctx.originalEntries
      .filter((e) => e.type !== "reversal" && e.status !== "reversed")
      .map((e) => ({
        reversesEntryId: e.id,
        affiliateId: e.affiliateId,
        amount: money(-e.amountCents, e.currency),
        conversionId: e.conversionId,
        reason: ctx.reason,
      }));
  }

  qualify(ctx: QualifyContext): Qualification {
    const { offer, priorVolumeCents } = ctx;
    const tiers = [...offer.tiers].sort((a, b) => a.minVolumeCents - b.minVolumeCents);
    let tier: string | null = null;
    let rate: number | null = offer.payoutType === "percentage" ? offer.payoutValue : null;
    let index = 0;
    for (const t of tiers) {
      if (priorVolumeCents >= t.minVolumeCents) {
        index += 1;
        tier = tierName(index);
        rate = t.rate;
      }
    }
    return { tier, rate, metadata: { priorVolumeCents } };
  }
}

function capCommission(amount: Money, offer: import("../types/program.js").Offer): Money {
  const cap = maxCommissionCents(offer);
  if (cap != null && amount.amountCents > cap) {
    return money(cap, amount.currency);
  }
  return amount;
}

function tierName(index: number): string {
  const names = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
  return names[index - 1] ?? `Tier ${index}`;
}
