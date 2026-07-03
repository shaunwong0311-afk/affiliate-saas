import { buildApp } from "../app.js";
import { seedDemo } from "./seed.js";
import { programHealth, moneyOps, recruitmentFunnel, affiliatePerformance, producingFunnel } from "../services/reporting.js";
import { computePayableLines } from "../services/payout-service.js";
import { autonomousCycle, sourceYield, deliverabilityHealth, getAutomationState, planDiscovery, activationMetrics, handleReply } from "@affiliate/recruitment";
import { money, formatMoney, scanContent } from "@affiliate/core";

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
  const allProspects = await ctx.db.prospects.find((p) => p.merchantId === merchantId);
  const demoCount = allProspects.filter((p) => p.synthetic).length;
  line("  RECRUITMENT FUNNEL (the wedge)");
  line(`    sourced ${funnel.sourced} → contacted ${funnel.contacted} → replied ${funnel.replied} → converted ${funnel.converted}`);
  line(`    tiers: ${JSON.stringify(funnel.byTier)}`);
  if (demoCount > 0)
    line(`    ⚠ ${demoCount}/${allProspects.length} are DEMO DATA (no SERP/email/backlink keys wired — set SERPAPI_KEY / HUNTER_API_KEY / DATAFORSEO_LOGIN for real discovery)`);
  line();

  const plan = await planDiscovery(ctx, merchantId);
  line("  DISCOVERY PLAN (the orchestrator decides what to run, warmest first)");
  for (const s of plan.steps) line(`    ✓ [P${s.priority}] ${s.label}`);
  for (const s of plan.skipped) line(`    ✗ ${s.sourceType} — skipped: ${s.reason}`);
  for (const note of plan.notes) line(`    · ${note}`);
  line();

  const auto = await getAutomationState(ctx, merchantId);
  const cycle = await autonomousCycle(ctx, merchantId); // one more cycle, live
  const deliv = await deliverabilityHealth(ctx, merchantId);
  line("  AUTONOMOUS ENGINE (from-scratch; L4 with HITL gates)");
  line(`    automation: ${auto.status}   auto-send ≥ ${auto.autoSendMinScore}   HITL tier ${auto.hitlTier}   meeting tier ${auto.meetingTier}`);
  line(`    last cycle → sourced ${cycle.sourced}, auto-sent ${cycle.autoSent}, follow-ups ${cycle.followUpsSent}, held for review ${cycle.heldForReview}`);
  line(`    deliverability: ${deliv.sent} sent, bounce ${(deliv.bounceRate * 100).toFixed(1)}%, circuit ${deliv.circuitOpen ? "OPEN (paused)" : "ok"}`);
  line();

  const prod = await producingFunnel(ctx, merchantId);
  line("  PRODUCING FUNNEL (cost per PRODUCING affiliate — the number that matters)");
  line(`    sourced ${prod.sourced} → recruited ${prod.recruited} → producing ${prod.producing}  (${(prod.percentProducingOfRecruited * 100).toFixed(0)}% of recruited)`);
  line(`    time-to-first-sale: ${prod.avgTimeToFirstSaleDays != null ? prod.avgTimeToFirstSaleDays.toFixed(1) + "d" : "n/a"}   enrichment units ${prod.enrichmentUnits}   send units ${prod.sendUnits}`);
  for (const s of (await sourceYield(ctx, merchantId)).slice(0, 4)) {
    line(`    source ${s.sourceType.padEnd(24)} sourced ${String(s.sourced).padStart(3)}  producing ${s.producing}  yield ${(s.yield * 100).toFixed(0)}%  rev ${formatMoney(money(s.producedRevenueCents, "USD"))}`);
  }
  line();

  const act = await activationMetrics(ctx, merchantId);
  line("  ACTIVATION (recruiting is vanity until recruits DRIVE a sale)");
  line(`    recruited ${act.recruited} → activated ${act.activated} (${(act.activationRate * 100).toFixed(0)}%) → producing ${act.producing} (${(act.producingRate * 100).toFixed(0)}%)`);
  line(`    fast-start earned ${act.fastStartEarned}   median days-to-first-sale: ${act.medianDaysToFirstSale != null ? act.medianDaysToFirstSale.toFixed(1) + "d" : "n/a"}`);
  line();

  line("  PRE-SEND CONTENT GATE (every outbound body is scanned before it leaves)");
  const spammy = scanContent({ subject: "ACT NOW!!! 100% FREE money — click here", body: "Guaranteed income, buy now, don't miss this once in a lifetime deal $$$" });
  const clean = scanContent({ subject: "Partner with Lumen Skincare?", body: "Hi there — loved your recent routine breakdown. We'd love to have you in our creator program. Open to details?" });
  line(`    spammy draft → ${spammy.severity} (score ${spammy.score}); issues: ${spammy.issues.map((i) => i.code).join(", ")}`);
  line(`    clean  draft → ${clean.severity} (score ${clean.score}) — cleared to send`);
  line();

  // Route one inbound question through the AI-SDR to show the reply-handoff loop end-to-end.
  const questionProspect = (await ctx.db.prospects.find((p) => p.merchantId === merchantId && p.email != null && p.state !== "converted")).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  if (questionProspect) {
    const state = await getAutomationState(ctx, merchantId);
    const outcome = await handleReply(ctx, questionProspect.id, "Interested — what commission do you pay and how long is the cookie?", { meetingTier: state.meetingTier, aiSdrMode: state.aiSdrMode });
    const openHandoffs = await ctx.db.handoffs.count((h) => h.merchantId === merchantId && h.status === "open");
    line("  AI-SDR REPLY LOOP (grounded answers; humans stay in the loop)");
    line(`    reply from ${questionProspect.identity} → classified ${outcome.classification}, action ${outcome.action}${outcome.needsHuman ? " (routed to a human)" : ""}`);
    if (outcome.answer) line(`    AI-SDR answer: ${outcome.answer.replace(/\s+/g, " ").slice(0, 120)}${outcome.answer.length > 120 ? "…" : ""}`);
    line(`    open handoffs waiting for the operator: ${openHandoffs}`);
    line();
  }

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
