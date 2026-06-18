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
import { money } from "../money.js";

/**
 * MLM engine — DELIBERATELY a stub (Section 5, Section 12).
 *
 * The architecture keeps an MLM/direct-selling engine a clean *future* option on
 * the same substrate, but it is NOT built now. It is a distinct vertical: licensed
 * merchants, MLM-appropriate rails (Stripe restricts MLM), and compliance tooling
 * (real-customer/retail-sales verification, buyback) that *is* the product. Wiring
 * a real genealogy traversal, PV/GV rollups, binary-leg carryover, matrix
 * spillover, rank qualification, and bonus pools here would be a substantial
 * separate build.
 *
 * This class exists to PROVE the seam: a second engine drops in behind the same
 * interface without touching the substrate. `runCycle` is where the real MLM work
 * would live (batch genealogy traversal between cycles).
 */
export class MlmEngineStub implements CommissionEngine {
  readonly kind = "mlm";

  onOrder(ctx: OnOrderContext): CommissionEvent[] {
    // MLM is batch-driven: on-order only records personal volume; the commission
    // run (runCycle) does genealogy traversal. A real build would accrue PV here.
    void ctx;
    return [];
  }

  runCycle(ctx: RunCycleContext): CommissionEvent[] {
    throw new NotImplementedError(
      "MlmEngineStub.runCycle: the MLM commission run (genealogy traversal, PV/GV " +
        "rollup, binary carryover, matrix spillover, rank qualification, bonus pools) " +
        "is a future vertical and is intentionally not implemented. " +
        `(merchant=${ctx.merchantId}, period=${ctx.period.start.toISOString()}..${ctx.period.end.toISOString()})`,
    );
  }

  onReversal(ctx: OnReversalContext): ReversalEvent[] {
    // The cascade pattern is identical to the affiliate engine but walks the full
    // upline rather than one level. Stubbed: reverse only what is present.
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

  qualify(_ctx: QualifyContext): Qualification {
    return { tier: null, rate: null, metadata: { note: "MLM rank qualification not implemented" } };
  }
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}
