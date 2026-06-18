import { buildApp } from "../app.js";
import { seedDemo } from "./seed.js";
import { programHealth, moneyOps, recruitmentFunnel, affiliatePerformance } from "../services/reporting.js";
import { computePayableLines } from "../services/payout-service.js";
import { money, formatMoney } from "@affiliate/core";

/**
 * End-to-end console narrative: seeds a tenant through the real substrate, then
 * prints what the engine computed. Run with `npm run demo`.
 */
async function main() {
  const app = await buildApp();
  const ctx = app.appContext;
  const { email, password, merchantId } = await seedDemo(ctx);

  const line = (s = "") => console.log(s);
  const rule = () => line("─".repeat(64));

  rule();
  line("  VANTAGE — affiliate recruitment platform · demo run");
  rule();
  line(`  merchant: Lumen Skincare   login: ${email} / ${password}`);
  line();

  const health = await programHealth(ctx, merchantId);
  line("  PROGRAM HEALTH");
  line(`    revenue via affiliates : ${money(health.revenueViaAffiliatesCents, "USD") && formatMoney(money(health.revenueViaAffiliatesCents, "USD"))}`);
  line(`    active affiliates      : ${health.activeAffiliates}   producing: ${health.producingAffiliates}`);
  line(`    conversions            : ${health.conversions}   EPC: ${formatMoney(money(health.epcCents, "USD"))}`);
  line(`    refund rate            : ${(health.refundRate * 100).toFixed(1)}%`);
  line();

  const m = await moneyOps(ctx, merchantId);
  line("  MONEY OPERATIONS (append-only ledger)");
  line(`    unpaid liability       : ${formatMoney(money(m.unpaidLiabilityCents, "USD"))}`);
  line(`    clawbacks (reversals)  : ${m.reversalCount}`);
  line(`    paid out               : ${formatMoney(money(m.paidCents, "USD"))}`);
  line();

  line("  AFFILIATE PERFORMANCE");
  for (const a of await affiliatePerformance(ctx, merchantId)) {
    line(`    ${a.name.padEnd(18)} ${a.role.padEnd(10)} earned ${formatMoney(money(a.earningsCents, "USD")).padStart(12)}  (${a.conversions} conv)`);
  }
  line();

  const funnel = await recruitmentFunnel(ctx, merchantId);
  line("  RECRUITMENT FUNNEL (the wedge)");
  line(`    sourced ${funnel.sourced} → contacted ${funnel.contacted} → replied ${funnel.replied} → converted ${funnel.converted}`);
  line(`    tiers: ${JSON.stringify(funnel.byTier)}`);
  line();

  line("  PAYOUT CONSOLE (orchestration without custody; tax-gated)");
  for (const p of await computePayableLines(ctx, merchantId, 100)) {
    const status = p.eligible ? "ELIGIBLE" : `blocked: ${p.blockedReason}`;
    line(`    ${p.affiliateName.padEnd(18)} available ${formatMoney(money(p.availableCents, p.currency)).padStart(12)}  [${status}]`);
  }
  rule();
  line("  Start the stack:  npm run api  ·  npm run edge  ·  npm run web:dev");
  rule();

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
