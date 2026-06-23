import {
  newId,
  scoreProspect as scoreSignals,
  detectAffiliateUrl,
  promotesCompetitor as detectPromotesCompetitor,
  hasProvenAffiliateSignal,
  canTransition,
  buildProfile,
  addPageToProfile,
  type ScoringSignals,
  type AffiliateSignal,
  type Tier,
  type Profile,
} from "@affiliate/core";
import type { Prospect, ProspectSignal, OutreachCampaign, OutreachMessage, Reply, Merchant } from "@affiliate/db";
import {
  renderTemplate,
  classifyReply,
  extractEmailsFromHtml,
  extractHrefs,
  discoverContactUrls,
  detectsContactForm,
  type DiscoveryQuery,
  type RedirectResolver,
} from "@affiliate/integrations";
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
    channels: ["serp", "youtube", "blog", "newsletter", "podcast", "community"],
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
      let signals: AffiliateSignal[] = cand.outboundLinks.flatMap((l) => detectAffiliateUrl(l));
      // Resolve LOW-confidence generic links (?ref=, ?via=, /go/) to their final
      // host so they can be trusted as competitor evidence. Named-network links are
      // already high-confidence and need no resolution. Only spend network calls on
      // REAL candidates (never on demo data) and only when a resolver is wired.
      if (deps.redirectResolver && !cand.synthetic) {
        signals = await resolveLowConfidenceSignals(deps.redirectResolver, signals);
      }
      // "Runs affiliate links" = a PROVEN monetizer: at least one HIGH-confidence
      // named-network signature. A bare generic `?ref=` is NOT proof on its own.
      const isAffiliate = hasProvenAffiliateSignal(signals);
      const promotesComp = detectPromotesCompetitor(signals, merchant.competitors);
      const competitorPromoted = firstPromotedCompetitor(signals, merchant.competitors);
      // Real contact extraction from the fetched page (mailto: first). Never guessed.
      const contactEmails = cand.pageHtml ? extractEmailsFromHtml(cand.pageHtml).slice(0, 5) : [];
      // Secondary contact surfaces the creator linked (Linktree, /contact, YT About)
      // — enrichment fetches these for more real emails. Plus a YouTube About tab
      // derived from the channel URL, and whether a contact FORM is present.
      const contactUrls = cand.pageHtml ? discoverContactUrls(cand.pageHtml, cand.siteUrl) : [];
      if (cand.channelUrl && /(^|\.)youtube\.com$/i.test(hostOf(cand.channelUrl) ?? "")) {
        const about = `${cand.channelUrl.replace(/\/+$/, "")}/about`;
        if (!contactUrls.some((u) => u.url === about)) contactUrls.push({ url: about, kind: "youtube_about" });
      }
      const hasContactForm = cand.pageHtml ? detectsContactForm(cand.pageHtml) : false;
      // Identity graph: classify the surfaces this creator links from their page.
      // The seed is their own URL; enrichment augments this from bio-aggregator pages.
      const seedUrl = cand.siteUrl ?? cand.channelUrl;
      const profile =
        seedUrl || cand.pageHtml
          ? buildProfile(seedUrl, cand.pageHtml ? [{ url: cand.evidenceUrl ?? seedUrl ?? cand.identity, links: extractHrefs(cand.pageHtml, seedUrl) }] : [])
          : null;

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
        synthetic: cand.synthetic,
        confidence: null,
        evidence: {
          affiliateLinks: signals.map((s) => ({ url: s.url, network: s.network, confidence: s.confidence, verified: s.verified })),
          competitorPromoted,
          contactSource: null,
          contactEmails,
          contactUrls,
          contactForm: hasContactForm,
          contactFormUrl: hasContactForm ? cand.evidenceUrl : null,
          profile,
          pageUrl: cand.evidenceUrl,
        },
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
        isAffiliate,
        promotesCompetitor: promotesComp,
        intent: /review|best|vs|compare/i.test(cand.evidenceSummary ?? "") ? 0.8 : 0.3,
        verifiedEmail: false,
        // Provider-backed signals are UNKNOWN at discovery — no SEO/audience/creator
        // provider has run. reachHint is a real-ish proxy only for customer mining
        // (lifetime spend); a real SERP hit has no reach until a provider is wired.
        reach: cand.reachHint ?? null,
        da: null,
        engagement: null,
        audienceOverlap: null,
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
  // Deliverability check: a wired EmailVerifier (real MX/SMTP) wins; otherwise the
  // EmailFinder's own verify(). We never mark an unverified address deliverable.
  const verify = (email: string) =>
    deps.emailVerifier ? deps.emailVerifier.verify(email) : deps.emailFinder.verify(email);

  let chosenEmail: string | null = null;
  let contactSource: string | null = null;

  // 1) PREFER emails actually extracted from the fetched page (real contact path).
  const extracted = prospect.evidence?.contactEmails ?? [];
  for (const c of extracted) {
    const v = await verify(c.email).catch(() => ({ deliverable: false, reason: "verify error" }));
    if (v.deliverable) {
      chosenEmail = c.email;
      contactSource = `page:${c.source}`;
      break;
    }
  }

  // 2) FOLLOW the contact-bearing pages the creator linked (Linktree, /contact,
  //    YouTube About). Each fetched page does double duty: extract real emails AND
  //    grow the identity graph (a Linktree enumerates all the creator's accounts —
  //    the strongest cross-platform signal). Real prospects with a fetcher only.
  let profile = (prospect.evidence?.profile as Profile | null) ?? null;
  const seedUrl = prospect.siteUrl ?? prospect.channelUrl;
  if (deps.fetcher && !prospect.synthetic) {
    for (const c of prospect.evidence?.contactUrls ?? []) {
      let html: string | null = null;
      try {
        const r = await deps.fetcher.get(c.url);
        if (r.status >= 200 && r.status < 300 && r.html && r.html.length > 200) html = r.html;
      } catch {
        /* skip unreachable contact page */
      }
      if (!html) continue;
      // Grow the graph from this page's links (bio aggregators are high-confidence).
      const page = { url: c.url, links: extractHrefs(html, c.url), bioAggregator: c.kind === "bio_aggregator" };
      profile = profile ? addPageToProfile(profile, page, seedUrl) : buildProfile(seedUrl, [page]);
      // Mine it for a deliverable contact email if we don't have one yet.
      if (!chosenEmail) {
        for (const f of extractEmailsFromHtml(html)) {
          const v = await verify(f.email).catch(() => ({ deliverable: false, reason: "verify error" }));
          if (v.deliverable) {
            chosenEmail = f.email;
            contactSource = `${c.kind}:${f.source}`;
            break;
          }
        }
      }
    }
  }

  // 3) FALL BACK to the EmailFinder (Hunter in prod; pattern-guessing stub in dev).
  //    Pattern-guessed addresses are clearly labeled so the UI can flag them.
  if (!chosenEmail) {
    const candidates = await deps.emailFinder
      .find({ fullName: prospect.identity, domain: domain ?? undefined, siteUrl: prospect.siteUrl ?? undefined })
      .catch(() => []);
    for (const c of candidates.sort((a, b) => b.confidence - a.confidence)) {
      const v = await verify(c.email).catch(() => ({ deliverable: false, reason: "verify error" }));
      if (v.deliverable) {
        chosenEmail = c.email;
        contactSource = c.source === "stub-finder" ? "pattern-guess" : c.source;
        break;
      }
    }
  }

  // Fill reach + engagement from the cheapest source per platform (YouTube API,
  // scrape-API for IG/TikTok/X, on-page for Substack). Real prospects only; we enrich
  // the primary + high-confidence accounts and cap the work. Unknown stays null.
  let audienceReach: number | null = null;
  let audienceEngagement: number | null = null;
  const enricher = deps.enricher;
  if (enricher && profile && !prospect.synthetic) {
    // Filter to BILLABLE (enricher-supported) accounts FIRST, then cap by confidence —
    // so the cap counts paid lookups, not graph nodes, and walled accounts aren't
    // crowded out by website/linktree nodes.
    const cap = deps.enrichmentMaxAccounts ?? 3;
    const targets = profile.accounts
      .filter((a) => (a.provenance === "seed" || a.confidence >= 0.85) && enricher.supports(a.platform))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, cap);
    for (const a of targets) {
      const m = await enricher.enrich({ platform: a.platform, handle: a.handle, url: a.url }).catch(() => null);
      if (!m) continue;
      if (m.reach != null) audienceReach = Math.max(audienceReach ?? 0, m.reach);
      if (m.engagementRate != null && audienceEngagement == null) audienceEngagement = m.engagementRate;
      if (profile.audience.primaryGeo == null && m.primaryGeo) profile.audience.primaryGeo = m.primaryGeo;
      if (profile.audience.language == null && m.language) profile.audience.language = m.language;
      profile.audience.source = m.source;
    }
    if (audienceReach != null) profile.audience.reach = audienceReach;
    if (audienceEngagement != null) profile.audience.engagementRate = audienceEngagement;
  }

  const signal = await deps.db.prospectSignals.findOne((s) => s.prospectId === prospectId);
  if (signal) {
    // verifiedEmail always; reach/engagement ONLY when a real enricher returned them.
    // DA / audience-overlap stay null unless their own provider is wired — never
    // estimated. The score's confidence reflects how much is real (scoring.ts).
    await deps.db.prospectSignals.update(signal.id, {
      verifiedEmail: !!chosenEmail,
      ...(audienceReach != null ? { reach: audienceReach } : {}),
      ...(audienceEngagement != null ? { engagement: audienceEngagement } : {}),
    } as Partial<ProspectSignal>);
  }

  const ts = deps.clock.now().toISOString();
  await deps.db.usageEvents.insert({ id: newId("use"), merchantId: prospect.merchantId, kind: "enrichment", quantity: 1, sourceId: prospectId, ts });
  return deps.db.prospects.update(prospectId, {
    email: chosenEmail,
    evidence: { ...(prospect.evidence ?? {}), contactSource, profile },
    state: "enriched",
    updatedAt: ts,
  });
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
    confidence: result.confidence,
    scoreBreakdown: { breakdown: result.breakdown, explanation: result.explanation, confidence: result.confidence, unknownFactors: result.unknownFactors },
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

/**
 * A pre-drafted first-touch message for the HUMAN-gated contact-form track. When a
 * prospect has only a contact form (no email), the operator opens the form and
 * pastes this — compliant, personalized by tier, never auto-submitted. Pure.
 */
export function draftOutreach(
  merchant: Pick<Merchant, "name" | "niche">,
  prospect: Pick<Prospect, "identity" | "tier">,
): { subject: string; body: string } {
  const niche = merchant.niche ?? "your space";
  const angle =
    prospect.tier === "A"
      ? `I came across your work in ${niche} and the affiliate links you already run — you'd be a standout fit for our program.`
      : prospect.tier === "B"
        ? `Your content is a great match for what we sell in ${niche}.`
        : `I think our affiliate program could be a fit for your audience.`;
  return {
    subject: `Partnering with ${merchant.name}`,
    body:
      `Hi ${prospect.identity},\n\n${angle}\n\n` +
      `We pay affiliates to promote ${merchant.niche ?? "our products"} and I'd love to send over the details — ` +
      `commission terms, creative, and your tracking link. Just reply and I'll share everything.\n\n` +
      `Thanks,\n${merchant.name}`,
  };
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

/**
 * Follow the redirect of each LOW-confidence generic link (`?ref=`, `?via=`, `/go/`)
 * and stamp the resolved final host onto the signal. High-confidence named-network
 * links are left untouched. A signal only becomes `verified` if the redirect was
 * actually followed — so unresolved generics never count as competitor evidence.
 */
async function resolveLowConfidenceSignals(resolver: RedirectResolver, signals: AffiliateSignal[]): Promise<AffiliateSignal[]> {
  const out: AffiliateSignal[] = [];
  for (const s of signals) {
    if (s.confidence === "low" && !s.verified) {
      const resolved = await resolver.resolve(s.url).catch(() => null);
      if (resolved) {
        out.push({ ...s, verified: true, resolvedHost: resolved.finalHost });
        continue;
      }
    }
    out.push(s);
  }
  return out;
}

/** The first competitor domain a link is KNOWN to point at (direct host or resolved). */
function firstPromotedCompetitor(signals: AffiliateSignal[], competitorDomains: string[]): string | null {
  const comps = competitorDomains.map((d) => d.toLowerCase().replace(/^www\./, ""));
  const match = (host: string | undefined): string | null => {
    if (!host) return null;
    const target = host.toLowerCase().replace(/^www\./, "");
    return comps.find((c) => target === c || target.endsWith(`.${c}`)) ?? null;
  };
  for (const s of signals) {
    const m = match(s.targetHost) ?? match(s.resolvedHost);
    if (m) return m;
  }
  return null;
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
