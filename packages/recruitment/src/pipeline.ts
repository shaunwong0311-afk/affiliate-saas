import {
  newId,
  scoreProspect as scoreSignals,
  detectAffiliateUrl,
  detectAffiliateLinksInHtml,
  promotesCompetitor as detectPromotesCompetitor,
  hasProvenAffiliateSignal,
  canTransition,
  buildProfile,
  addPageToProfile,
  mergeProfiles,
  identitySignalsFromProfile,
  identitiesOverlap,
  hasIdentitySignal,
  audienceOverlapScore,
  targetMarketForCurrency,
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
  type RawCandidate,
} from "@affiliate/integrations";
import type { RecruitmentDeps } from "./deps.js";
import type { DiscoveryPlan } from "./discovery-planner.js";
import { isSuppressed, suppress } from "./suppression.js";
import { isExistingAffiliate } from "./guards.js";
import { resolveContact } from "./contact-resolver.js";
import { personalizeOutreach } from "./personalization.js";
import { firstStep, personalizationDepth, pickVariant } from "./sequencing.js";
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
  opts?: { limit?: number; excludeSourceTypes?: string[]; plan?: DiscoveryPlan },
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
  // Run sources in the planner's priority order (warmest first), skipping the ones
  // it ruled out. Falls back to the natural order when no plan is supplied.
  let sources = deps.discoverySources;
  if (opts?.plan) {
    const order = new Map(opts.plan.steps.map((s, i) => [s.sourceType, i]));
    const skip = new Set(opts.plan.skipped.map((s) => s.sourceType));
    sources = deps.discoverySources
      .filter((s) => !skip.has(s.sourceType))
      .sort((a, b) => (order.get(a.sourceType) ?? 99) - (order.get(b.sourceType) ?? 99));
  }

  const created: Prospect[] = [];
  for (const source of sources) {
    if (excluded.has(source.sourceType)) continue; // source-yield pruning
    let candidates;
    try {
      candidates = await source.discover(query);
    } catch {
      continue; // isolate source failures (Section 8.1)
    }
    for (const cand of candidates) {
      const prospect = await ingestCandidate(deps, merchant, cand);
      if (prospect) created.push(prospect);
    }
  }
  return created;
}

/**
 * Turn one raw candidate into a persisted prospect (dedup → detect → identity graph →
 * insert prospect + source + signals). Returns null on a duplicate. Shared by the
 * discovery loop and the recursive frontier engine so both ingest identically.
 */
export async function ingestCandidate(deps: RecruitmentDeps, merchant: Merchant, cand: RawCandidate): Promise<Prospect | null> {
  const merchantId = merchant.id;
  // Fast path: exact re-discovery of the same surface (cheap, runs before the resolver).
  // For URL-less candidates (e.g. customer mining) fall back to identity-name equality.
  const exact = await deps.db.prospects.findOne((p) => {
    if (p.merchantId !== merchantId) return false;
    if (cand.siteUrl && p.siteUrl === cand.siteUrl) return true;
    if (cand.channelUrl && p.channelUrl === cand.channelUrl) return true;
    if (!cand.siteUrl && !cand.channelUrl && p.identity === cand.identity) return true;
    return false;
  });
  if (exact) return null;

  const now = deps.clock.now().toISOString();
  let signals: AffiliateSignal[] = cand.outboundLinks.flatMap((l) => detectAffiliateUrl(l));
  // Resolve LOW-confidence generic links to their final host (only real candidates,
  // only when a resolver is wired) so they can be trusted as competitor evidence.
  if (deps.redirectResolver && !cand.synthetic) {
    signals = await resolveLowConfidenceSignals(deps.redirectResolver, signals);
  }
  // A source may already have CONFIRMED the competitor (backlink mining filtered by the
  // merchant id) even though the link points at a network domain — trust it.
  const isAffiliate = hasProvenAffiliateSignal(signals);
  const promotesComp = !!cand.confirmedCompetitor || detectPromotesCompetitor(signals, merchant.competitors);
  const competitorPromoted = cand.confirmedCompetitor ?? firstPromotedCompetitor(signals, merchant.competitors);
  const contactEmails = cand.pageHtml ? extractEmailsFromHtml(cand.pageHtml).slice(0, 5) : [];
  const contactUrls = cand.pageHtml ? discoverContactUrls(cand.pageHtml, cand.siteUrl) : [];
  if (cand.channelUrl && /(^|\.)youtube\.com$/i.test(hostOf(cand.channelUrl) ?? "")) {
    const about = `${cand.channelUrl.replace(/\/+$/, "")}/about`;
    if (!contactUrls.some((u) => u.url === about)) contactUrls.push({ url: about, kind: "youtube_about" });
  }
  const hasContactForm = cand.pageHtml ? detectsContactForm(cand.pageHtml) : false;
  const seedUrl = cand.siteUrl ?? cand.channelUrl;
  const profile =
    seedUrl || cand.pageHtml
      ? buildProfile(seedUrl, cand.pageHtml ? [{ url: cand.evidenceUrl ?? seedUrl ?? cand.identity, links: extractHrefs(cand.pageHtml, seedUrl) }] : [])
      : null;

  // Cross-platform identity merge: is this the SAME creator as an existing prospect,
  // surfaced via a DIFFERENT channel (e.g. a YouTube channel found on its own, then the
  // creator's website via backlinks)? Merge into it — one comprehensive profile — rather
  // than creating a duplicate. Matches on a shared social handle, contact email, or
  // website domain (never on name alone).
  const candSignals = identitySignalsFromProfile(profile, contactEmails.map((e) => e.email));
  if (hasIdentitySignal(candSignals)) {
    const others = await deps.db.prospects.find((p) => p.merchantId === merchantId);
    for (const other of others) {
      const otherEmails = [other.email, ...(((other.evidence?.contactEmails as { email: string }[] | undefined) ?? []).map((e) => e.email))];
      const otherSignals = identitySignalsFromProfile((other.evidence?.profile as Profile | null) ?? null, otherEmails);
      if (identitiesOverlap(candSignals, otherSignals)) {
        await mergeCandidateInto(deps, other, cand, { signals, profile, contactEmails, contactUrls, hasContactForm, competitorPromoted, isAffiliate, promotesComp, now });
        return null; // enriched an existing prospect — not a net-new one
      }
    }
  }

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
    reach: cand.reachHint ?? null,
    da: cand.domainAuthority ?? null, // backlink mining supplies the referring-domain rank free
    engagement: null,
    audienceOverlap: null,
  });
  return prospect;
}

// ---- 2. Enrich --------------------------------------------------------------
export async function enrich(
  deps: RecruitmentDeps,
  prospectId: string,
  opts?: { maxAccounts?: number },
): Promise<Prospect> {
  const prospect = await deps.db.prospects.require(prospectId);
  if (!canTransition(prospect.state, "enriched")) return prospect;

  const domain = hostOf(prospect.siteUrl ?? prospect.channelUrl);
  // Deliverability check: a wired EmailVerifier (real MX/SMTP) wins; otherwise the
  // EmailFinder's own verify(). We never mark an unverified address deliverable.
  const verify = (email: string) =>
    deps.emailVerifier ? deps.emailVerifier.verify(email) : deps.emailFinder.verify(email);

  let chosenEmail: string | null = null;
  let contactSource: string | null = null;

  let profile = (prospect.evidence?.profile as Profile | null) ?? null;
  const seedUrl = prospect.siteUrl ?? prospect.channelUrl;
  let pageEmails = prospect.evidence?.contactEmails ?? [];
  let contactUrls = prospect.evidence?.contactUrls ?? [];
  let contactForm = prospect.evidence?.contactForm ?? false;
  let contactFormUrl = prospect.evidence?.contactFormUrl ?? null;
  let affiliateLinks = prospect.evidence?.affiliateLinks ?? [];

  // 0) If the SOURCE never fetched this prospect's page (backlink mining gives us only
  //    their domain + the one competitor link), fetch their homepage NOW so the same
  //    extractors light up: real on-page email, identity graph (their other platforms),
  //    contact URLs/form, and their full affiliate-link profile. Real prospects + a
  //    fetcher only; skipped when the source already provided page data (e.g. SERP).
  if (deps.fetcher && !prospect.synthetic && seedUrl && pageEmails.length === 0 && contactUrls.length === 0) {
    try {
      const r = await deps.fetcher.get(seedUrl);
      if (r.status >= 200 && r.status < 300 && r.html && r.html.length > 200) {
        const html = r.html;
        pageEmails = extractEmailsFromHtml(html).slice(0, 5);
        contactUrls = discoverContactUrls(html, seedUrl);
        contactForm = detectsContactForm(html);
        contactFormUrl = contactForm ? (prospect.siteUrl ?? seedUrl) : contactFormUrl;
        const page = { url: seedUrl, links: extractHrefs(html, seedUrl) };
        profile = profile ? addPageToProfile(profile, page, seedUrl) : buildProfile(seedUrl, [page]);
        // Capture their full affiliate-link profile (merged, deduped) — richer evidence
        // AND the recursive frontier reads it to find the OTHER merchants they promote.
        const found = detectAffiliateLinksInHtml(html).map((s) => ({ url: s.url, network: s.network, confidence: s.confidence, verified: s.verified }));
        const seen = new Set(affiliateLinks.map((l) => l.url));
        affiliateLinks = [...affiliateLinks, ...found.filter((l) => !seen.has(l.url))];
      }
    } catch {
      /* unreachable homepage — fall through to the finder */
    }
  }

  // 1+2) BEST-EFFORT contact resolution as a TRAVERSAL of the identity graph: try the
  //   on-page emails first, then walk every linked property — Linktree, /contact, the
  //   website, the YouTube channel description (free API), social bios — EXPANDING as it
  //   goes (a social bio → the website → /contact → the email). Converges from any entry
  //   point; stops at the first deliverable address. Grows the graph with all it fetched.
  const resolution = await resolveContact(
    { fetcher: deps.fetcher, enricher: deps.enricher, verify },
    {
      profile,
      seedUrl,
      canFetch: !!deps.fetcher && !prospect.synthetic,
      knownEmails: pageEmails,
      knownContactUrls: contactUrls,
      contactForm,
      contactFormUrl,
    },
  );
  chosenEmail = resolution.email;
  contactSource = resolution.source;
  profile = resolution.profile;
  contactForm = resolution.contactForm;
  contactFormUrl = resolution.contactFormUrl;

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
    const cap = opts?.maxAccounts ?? deps.enrichmentMaxAccounts ?? 3;
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

  // Geo/language alignment: if a provider gave us the creator's real geo/language,
  // turn it into the audienceOverlap signal vs the merchant's market (currency-derived).
  // Stays null when the creator's geo AND language are both unknown — never invented.
  let audienceOverlap: number | null = null;
  if (profile && (profile.audience.primaryGeo != null || profile.audience.language != null)) {
    const merchant = await deps.db.merchants.get(prospect.merchantId);
    audienceOverlap = audienceOverlapScore(
      { primaryGeo: profile.audience.primaryGeo, language: profile.audience.language },
      targetMarketForCurrency(merchant?.defaultCurrency),
    );
  }

  const signal = await deps.db.prospectSignals.findOne((s) => s.prospectId === prospectId);
  if (signal) {
    // verifiedEmail always; reach/engagement/overlap ONLY when real data backs them.
    // DA stays as the source supplied it; nothing here is estimated. The score's
    // confidence reflects how much is real (scoring.ts).
    await deps.db.prospectSignals.update(signal.id, {
      verifiedEmail: !!chosenEmail,
      ...(audienceReach != null ? { reach: audienceReach } : {}),
      ...(audienceEngagement != null ? { engagement: audienceEngagement } : {}),
      ...(audienceOverlap != null ? { audienceOverlap } : {}),
    } as Partial<ProspectSignal>);
  }

  const ts = deps.clock.now().toISOString();
  await deps.db.usageEvents.insert({ id: newId("use"), merchantId: prospect.merchantId, kind: "enrichment", quantity: 1, sourceId: prospectId, ts });
  return deps.db.prospects.update(prospectId, {
    email: chosenEmail,
    evidence: { ...(prospect.evidence ?? {}), contactSource, profile, contactEmails: pageEmails, contactUrls, contactForm, contactFormUrl, affiliateLinks },
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
  // Prefer the (LLM-backed) relevance scorer when wired — semantic niche fit, not just
  // shared tokens. Falls back to the lexical embedder when no scorer is injected.
  const relevance = deps.relevanceScorer
    ? await deps.relevanceScorer.score({ prospect: prospectText, merchant: merchantText })
    : await deps.embedder.similarity(prospectText, merchantText);

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
  // Never cold-email someone who is ALREADY this merchant's affiliate.
  if (await isExistingAffiliate(deps, prospect.merchantId, prospect)) {
    await deps.db.prospects.update(prospectId, { state: "dead", updatedAt: deps.clock.now().toISOString() });
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

  // A/B: when the step defines variants, pick one (even, deterministic per prospect) and
  // personalize within it. The chosen variant is recorded for reply-rate-by-variant analysis.
  let effectiveStep = step;
  let abLabel: string | null = null;
  if (step.variants?.length) {
    const picked = pickVariant(step.variants, prospectId);
    effectiveStep = { ...step, subject: picked.value.subject, body: picked.value.body };
    abLabel = `ab:v${picked.index}`;
  }
  // Personalize per the merchant's plan (template / hybrid / llm). The LLM path cites the
  // prospect's real evidence; falls back to the token template otherwise or on any failure.
  const personalized = await personalizeOutreach(deps, { merchant, prospect, step: effectiveStep, tokens });

  const now = deps.clock.now().toISOString();
  const message: OutreachMessage = {
    id: newId("omsg"),
    prospectId,
    campaignId: campaign.id,
    step: step.step,
    // LLM bodies are personalized per-prospect (no fixed variant to test); template sends
    // carry the A/B label so variant reply-rates are comparable.
    variant: personalized.mode === "llm" ? "llm" : abLabel ?? depth,
    subject: personalized.subject,
    body: personalized.body,
    sentAt: null,
    status: "queued",
  };
  await deps.db.outreachMessages.insert(message);
  // Meter LLM personalizations for plan-tier billing (one event per LLM-written email).
  if (personalized.mode === "llm") {
    await deps.db.usageEvents.insert({ id: newId("use"), merchantId: prospect.merchantId, kind: "personalization", quantity: 1, sourceId: message.id, ts: now });
  }
  await deps.db.prospects.update(prospectId, { state: "queued", updatedAt: now });
  return message;
}

/** Render (without queuing) the first-touch email for a prospect — the preview/test-send. */
export async function previewOutreach(
  deps: RecruitmentDeps,
  prospectId: string,
  campaign: OutreachCampaign,
): Promise<{ subject: string; body: string; mode: "template" | "llm" } | null> {
  const prospect = await deps.db.prospects.require(prospectId);
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
  return personalizeOutreach(deps, { merchant, prospect, step, tokens });
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
  const unsubUrl = unsubscribeLink(prospect.merchantId, prospect.email);
  // CAN-SPAM compliant footer: valid physical address + one-click unsubscribe.
  const footer =
    `\n\n—\n${merchant.name}` +
    (merchant.physicalAddress ? `\n${merchant.physicalAddress}` : "") +
    `\nUnsubscribe: reply STOP, or ${unsubUrl}`;
  // One-click List-Unsubscribe (RFC 8058) — REQUIRED by Gmail/Yahoo bulk-sender rules. The
  // POST variant lets the inbox unsubscribe the user without opening the link.
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${unsubUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  // Send AS the merchant: resolve their connected mailbox (SMTP/Graph/Gmail). Falls back to
  // the default mailer (the dev/test mock) when no resolver is wired or the mailbox is gone.
  const sender = deps.mailboxResolver ? await deps.mailboxResolver(campaign.mailboxId).catch(() => deps.mailer) : deps.mailer;
  const result = await sender.send({
    fromName: merchant.name,
    fromEmail: mailbox?.email ?? `team@${merchant.name.toLowerCase().replace(/\s+/g, "")}.com`,
    toEmail: prospect.email,
    subject: message.subject,
    body: message.body + footer,
    headers,
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

interface MergeParts {
  signals: AffiliateSignal[];
  profile: Profile | null;
  contactEmails: { email: string; source: string }[];
  contactUrls: { url: string; kind: string }[];
  hasContactForm: boolean;
  competitorPromoted: string | null;
  isAffiliate: boolean;
  promotesComp: boolean;
  now: string;
}

/**
 * Fold a candidate (a different surface of an already-known creator) into the existing
 * prospect: union the identity graph, affiliate links, contact emails/urls; fill any
 * missing site/channel URL; record the new evidence source; and strengthen the signal
 * (OR the booleans, keep the best known reach/DA). Builds one comprehensive profile.
 */
async function mergeCandidateInto(deps: RecruitmentDeps, target: Prospect, cand: RawCandidate, parts: MergeParts): Promise<void> {
  const ev = (target.evidence ?? {}) as Record<string, unknown>;
  const existingProfile = (ev.profile as Profile | null) ?? null;
  const mergedProfile = parts.profile && existingProfile ? mergeProfiles(existingProfile, parts.profile) : (existingProfile ?? parts.profile ?? null);

  const newLinks = parts.signals.map((s) => ({ url: s.url, network: s.network, confidence: s.confidence, verified: s.verified }));
  const affiliateLinks = unionBy([...((ev.affiliateLinks as typeof newLinks) ?? []), ...newLinks], (l) => l.url);
  const contactEmails = unionBy([...((ev.contactEmails as typeof parts.contactEmails) ?? []), ...parts.contactEmails], (e) => e.email);
  const contactUrls = unionBy([...((ev.contactUrls as typeof parts.contactUrls) ?? []), ...parts.contactUrls], (u) => u.url);

  await deps.db.prospects.update(target.id, {
    siteUrl: target.siteUrl ?? cand.siteUrl,
    channelUrl: target.channelUrl ?? cand.channelUrl,
    evidence: {
      ...ev,
      profile: mergedProfile,
      affiliateLinks,
      contactEmails,
      contactUrls,
      competitorPromoted: (ev.competitorPromoted as string | null) ?? parts.competitorPromoted,
      contactForm: !!ev.contactForm || parts.hasContactForm,
    },
    updatedAt: parts.now,
  });

  await deps.db.prospectSources.insert({
    id: newId("psrc"),
    prospectId: target.id,
    sourceType: cand.sourceType,
    evidenceUrl: cand.evidenceUrl,
    evidenceSummary: cand.evidenceSummary,
    capturedAt: parts.now,
  });

  const sig = await deps.db.prospectSignals.findOne((s) => s.prospectId === target.id);
  if (sig) {
    await deps.db.prospectSignals.update(sig.id, {
      isAffiliate: sig.isAffiliate || parts.isAffiliate,
      promotesCompetitor: sig.promotesCompetitor || parts.promotesComp,
      reach: maxNullable(sig.reach, cand.reachHint ?? null),
      da: maxNullable(sig.da, cand.domainAuthority ?? null),
    } as Partial<ProspectSignal>);
  }
}

function unionBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
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
