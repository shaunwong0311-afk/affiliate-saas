import {
  newId,
  scoreProspect as scoreSignals,
  detectAffiliateUrl,
  promotesCompetitor as detectPromotesCompetitor,
  canTransition,
  type ScoringSignals,
  type AffiliateSignal,
} from "@affiliate/core";
import type { Prospect, ProspectSignal, OutreachCampaign, OutreachMessage, Reply } from "@affiliate/db";
import { renderTemplate, classifyReply, type DiscoveryQuery } from "@affiliate/integrations";
import type { RecruitmentDeps } from "./deps.js";
import { isSuppressed, suppress } from "./suppression.js";
import { firstStep, personalizationDepth } from "./sequencing.js";
import { weightsForMerchant } from "./learning.js";

/**
 * The recruitment pipeline (Section 8). Six stages, each a pure-ish step over the
 * deps: source → enrich → score → outreach → reply → closed loop. Targeting is the
 * moat; these stages exist so the highest-signal prospects (competitor affiliates)
 * surface, get scored for "will drive sales," and are contacted as the merchant.
 */

// ---- 1. Source / discover ---------------------------------------------------
export async function discover(
  deps: RecruitmentDeps,
  merchantId: string,
  opts?: { limit?: number; excludeSourceTypes?: string[] },
): Promise<Prospect[]> {
  const merchant = await deps.db.merchants.require(merchantId);
  const query: DiscoveryQuery = {
    merchantId,
    niche: merchant.niche ?? "general",
    competitors: merchant.competitors,
    keywords: [`best ${merchant.niche ?? "products"}`, `${merchant.niche ?? "product"} review`],
    channels: ["serp", "youtube", "blog", "community"],
    limit: opts?.limit ?? 10,
  };

  const excluded = new Set(opts?.excludeSourceTypes ?? []);
  const created: Prospect[] = [];
  for (const source of deps.discoverySources) {
    if (excluded.has(source.sourceType)) continue; // source-yield pruning
    let candidates;
    try {
      candidates = await source.discover(query);
    } catch {
      continue; // isolate source failures (Section 8.1)
    }
    for (const cand of candidates) {
      // Dedup against existing prospects for this merchant.
      const key = cand.siteUrl ?? cand.channelUrl ?? cand.identity;
      const dupe = await deps.db.prospects.findOne(
        (p) => p.merchantId === merchantId && (p.siteUrl === key || p.channelUrl === key || p.identity === cand.identity),
      );
      if (dupe) continue;

      const now = deps.clock.now().toISOString();
      const signals: AffiliateSignal[] = cand.outboundLinks.flatMap((l) => detectAffiliateUrl(l));
      const isAffiliate = signals.length > 0;
      const promotesComp = detectPromotesCompetitor(signals, merchant.competitors);

      const prospect: Prospect = {
        id: newId("prosp"),
        merchantId,
        source: cand.sourceType,
        identity: cand.identity,
        siteUrl: cand.siteUrl,
        channelUrl: cand.channelUrl,
        email: null,
        state: "discovered",
        score: null,
        tier: null,
        country: null,
        language: null,
        suppressionStatus: "none",
        scoreBreakdown: null,
        createdAt: now,
        updatedAt: now,
      };
      await deps.db.prospects.insert(prospect);
      await deps.db.prospectSources.insert({
        id: newId("psrc"),
        prospectId: prospect.id,
        sourceType: cand.sourceType,
        evidenceUrl: cand.evidenceUrl,
        evidenceSummary: cand.evidenceSummary,
        capturedAt: now,
      });
      await deps.db.prospectSignals.insert({
        id: newId("psig"),
        prospectId: prospect.id,
        relevance: 0,
        reach: cand.reachHint ?? 0,
        da: 0,
        engagement: 0,
        isAffiliate,
        promotesCompetitor: promotesComp,
        intent: /review|best|vs|compare/i.test(cand.evidenceSummary ?? "") ? 0.8 : 0.3,
        verifiedEmail: false,
        audienceOverlap: 0.5,
      });
      created.push(prospect);
    }
  }
  return created;
}

// ---- 2. Enrich --------------------------------------------------------------
export async function enrich(deps: RecruitmentDeps, prospectId: string): Promise<Prospect> {
  const prospect = await deps.db.prospects.require(prospectId);
  if (!canTransition(prospect.state, "enriched")) return prospect;

  const domain = hostOf(prospect.siteUrl ?? prospect.channelUrl);
  const candidates = await deps.emailFinder.find({ fullName: prospect.identity, domain: domain ?? undefined, siteUrl: prospect.siteUrl ?? undefined });
  let chosenEmail: string | null = null;
  for (const c of candidates.sort((a, b) => b.confidence - a.confidence)) {
    const verify = await deps.emailFinder.verify(c.email);
    if (verify.deliverable) {
      chosenEmail = c.email;
      break;
    }
  }

  const signal = await deps.db.prospectSignals.findOne((s) => s.prospectId === prospectId);
  if (signal) {
    await deps.db.prospectSignals.update(signal.id, {
      verifiedEmail: !!chosenEmail,
      da: estimateDomainAuthority(domain),
      engagement: 0.02 + (signal.reach > 0 ? Math.min(0.08, 100_000 / signal.reach) : 0.02),
    } as Partial<ProspectSignal>);
  }

  const ts = deps.clock.now().toISOString();
  await deps.db.usageEvents.insert({ id: newId("use"), merchantId: prospect.merchantId, kind: "enrichment", quantity: 1, sourceId: prospectId, ts });
  return deps.db.prospects.update(prospectId, { email: chosenEmail, state: "enriched", updatedAt: ts });
}

// ---- 3. Score ---------------------------------------------------------------
export async function score(deps: RecruitmentDeps, prospectId: string): Promise<Prospect> {
  const prospect = await deps.db.prospects.require(prospectId);
  const merchant = await deps.db.merchants.require(prospect.merchantId);
  const signal = await deps.db.prospectSignals.findOne((s) => s.prospectId === prospectId);
  if (!signal) return prospect;
  if (prospect.state !== "enriched" && prospect.state !== "scored") return prospect;

  const source = await deps.db.prospectSources.findOne((s) => s.prospectId === prospectId);
  const prospectText = `${prospect.identity} ${source?.evidenceSummary ?? ""}`;
  const merchantText = `${merchant.niche ?? ""} ${merchant.name}`;
  const relevance = await deps.embedder.similarity(prospectText, merchantText);

  const scoringSignals: ScoringSignals = {
    relevance,
    runsAffiliateLinks: signal.isAffiliate,
    promotesCompetitor: signal.promotesCompetitor,
    reach: signal.reach,
    domainAuthority: signal.da,
    engagementRate: signal.engagement,
    commercialIntent: signal.intent,
    contactable: signal.verifiedEmail || !!prospect.email,
    audienceOverlap: signal.audienceOverlap,
  };
  // Closed loop: blend toward weights learned from this merchant's producer outcomes.
  const weights = await weightsForMerchant(deps, prospect.merchantId);
  const result = scoreSignals(scoringSignals, weights);

  await deps.db.prospectSignals.update(signal.id, { relevance });
  return deps.db.prospects.update(prospectId, {
    score: result.score,
    tier: result.tier,
    scoreBreakdown: { breakdown: result.breakdown, explanation: result.explanation },
    state: "scored",
    updatedAt: deps.clock.now().toISOString(),
  });
}

// ---- 4. Outreach: build the first message for a campaign --------------------
export async function queueFirstTouch(
  deps: RecruitmentDeps,
  prospectId: string,
  campaign: OutreachCampaign,
): Promise<OutreachMessage | null> {
  const prospect = await deps.db.prospects.require(prospectId);
  if (!prospect.email) return null;
  if (await isSuppressed(deps, prospect.merchantId, prospect.email)) {
    await deps.db.prospects.update(prospectId, { state: "suppressed", suppressionStatus: "suppressed" });
    return null;
  }
  const step = firstStep(campaign);
  if (!step) return null;
  const merchant = await deps.db.merchants.require(prospect.merchantId);

  const depth = personalizationDepth(prospect.tier);
  const tokens = {
    name: prospect.identity,
    merchant: merchant.name,
    offer: merchant.niche ?? "our products",
    angle:
      depth === "deep"
        ? "I saw your reviews in this exact niche and your affiliate links — you'd be a strong fit."
        : depth === "medium"
          ? "Your content is a great match for our products."
          : "Thought our affiliate program might interest you.",
  };

  const message: OutreachMessage = {
    id: newId("omsg"),
    prospectId,
    campaignId: campaign.id,
    step: step.step,
    variant: depth,
    subject: renderTemplate(step.subject, tokens),
    body: renderTemplate(step.body, tokens),
    sentAt: null,
    status: "queued",
  };
  await deps.db.outreachMessages.insert(message);
  await deps.db.prospects.update(prospectId, { state: "queued", updatedAt: deps.clock.now().toISOString() });
  return message;
}

// ---- 4b. Send a queued message as the merchant ------------------------------
export async function send(deps: RecruitmentDeps, messageId: string): Promise<OutreachMessage> {
  const message = await deps.db.outreachMessages.require(messageId);
  const prospect = await deps.db.prospects.require(message.prospectId);
  const campaign = await deps.db.campaigns.require(message.campaignId);
  const merchant = await deps.db.merchants.require(prospect.merchantId);
  if (!prospect.email) return message;

  if (await isSuppressed(deps, prospect.merchantId, prospect.email)) {
    return deps.db.outreachMessages.update(messageId, { status: "failed" });
  }

  // Geo-gate EU/Canada cold outreach (Section 8.9 — GDPR/CASL are strict/high-risk).
  if (prospect.country && GEO_GATED.has(prospect.country.toUpperCase())) {
    return deps.db.outreachMessages.update(messageId, { status: "failed" });
  }

  const mailbox = campaign.mailboxId ? await deps.db.mailboxes.get(campaign.mailboxId) : null;
  // CAN-SPAM compliant footer: valid physical address + one-click unsubscribe.
  const footer =
    `\n\n—\n${merchant.name}` +
    (merchant.physicalAddress ? `\n${merchant.physicalAddress}` : "") +
    `\nUnsubscribe: reply STOP, or ${unsubscribeLink(prospect.merchantId, prospect.email)}`;
  const result = await deps.mailer.send({
    fromName: merchant.name,
    fromEmail: mailbox?.email ?? `team@${merchant.name.toLowerCase().replace(/\s+/g, "")}.com`,
    toEmail: prospect.email,
    subject: message.subject,
    body: message.body + footer,
  });

  const now = deps.clock.now().toISOString();
  if (result.status === "bounced") {
    await suppress(deps, { merchantId: prospect.merchantId, email: prospect.email, reason: "hard bounce", scope: "merchant" });
    await deps.db.prospects.update(prospect.id, { state: "bounced", suppressionStatus: "bounced", updatedAt: now });
    return deps.db.outreachMessages.update(messageId, { status: "bounced", sentAt: now });
  }

  const nextState = prospect.state === "queued" ? "contacted" : "in_sequence";
  await deps.db.prospects.update(prospect.id, { state: nextState, updatedAt: now });
  await deps.db.usageEvents.insert({ id: newId("use"), merchantId: prospect.merchantId, kind: "send", quantity: 1, sourceId: message.id, ts: now });
  return deps.db.outreachMessages.update(messageId, { status: "sent", sentAt: now });
}

// ---- 5. Reply handling ------------------------------------------------------
export interface ReplyRouting {
  reply: Reply;
  action: "suppress" | "hitl_queue" | "ai_sdr" | "ignore";
}

export async function ingestReply(deps: RecruitmentDeps, prospectId: string, raw: string): Promise<ReplyRouting> {
  const prospect = await deps.db.prospects.require(prospectId);
  const classification = classifyReply(raw) as Reply["classification"];
  const now = deps.clock.now().toISOString();

  const reply: Reply = { id: newId("rep"), prospectId, raw, classification, handledBy: null, ts: now };
  await deps.db.replies.insert(reply);

  let action: ReplyRouting["action"] = "ignore";
  if (classification === "unsubscribe") {
    if (prospect.email) await suppress(deps, { merchantId: prospect.merchantId, email: prospect.email, reason: "unsubscribe", scope: "global" });
    await deps.db.prospects.update(prospectId, { state: "suppressed", suppressionStatus: "suppressed", updatedAt: now });
    action = "suppress";
  } else if (classification === "interested" || classification === "question") {
    // The single highest-value HITL checkpoint (Section 8.5).
    await deps.db.prospects.update(prospectId, { state: "replied", updatedAt: now });
    action = classification === "question" ? "ai_sdr" : "hitl_queue";
  } else if (classification === "not_interested") {
    await deps.db.prospects.update(prospectId, { state: "dead", updatedAt: now });
  }

  return { reply, action };
}

// ---- helpers ----------------------------------------------------------------
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** EU + Canada — cold B2B email is restricted (GDPR/ePrivacy) or consent-based (CASL). */
const GEO_GATED: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
  "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "CA",
]);

function unsubscribeLink(merchantId: string, email: string): string {
  // Points at the API's real public unsubscribe endpoint (GET /track/unsubscribe).
  const base = process.env.PUBLIC_API_URL ?? "http://localhost:8787";
  return `${base}/track/unsubscribe?m=${encodeURIComponent(merchantId)}&e=${encodeURIComponent(email)}`;
}

function estimateDomainAuthority(domain: string | null): number {
  if (!domain) return 0;
  // Deterministic pseudo-DA from the domain string (stub for a real DA provider).
  let h = 0;
  for (const ch of domain) h = (h * 31 + ch.charCodeAt(0)) % 100;
  return 20 + (h % 60);
}
