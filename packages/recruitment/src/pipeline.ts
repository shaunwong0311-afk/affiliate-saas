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
  hasIdentitySignal,
  audienceOverlapScore,
  targetMarketForCurrency,
  activityRecency,
  isStale,
  scanContent,
  signUnsubscribeToken,
  resolveUnsubscribeSecret,
  type ScoringSignals,
  type AffiliateSignal,
  type Tier,
  type Profile,
  type IdentitySignals,
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
    channels: ["serp", "youtube", "blog", "newsletter", "podcast", "community", "social"],
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
  // One identity-key index for the whole run: candidates dedup/merge against it in O(1)
  // instead of each ingest rescanning every prospect (was O(C×N)).
  const identityIndex = await buildIdentityIndex(deps, merchantId);
  for (const source of sources) {
    if (excluded.has(source.sourceType)) continue; // source-yield pruning
    let candidates;
    try {
      candidates = await source.discover(query);
    } catch {
      continue; // isolate source failures (Section 8.1)
    }
    for (const cand of candidates) {
      const prospect = await ingestCandidate(deps, merchant, cand, { identityIndex });
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
export async function ingestCandidate(
  deps: RecruitmentDeps,
  merchant: Merchant,
  cand: RawCandidate,
  opts?: { identityIndex?: IdentityIndex },
): Promise<Prospect | null> {
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
  // Look the candidate up against a merchant identity-key INDEX rather than rescanning (and
  // recomputing signals for) every prospect per candidate (was O(C×N)). The loop callers
  // (discover/frontier) build ONE index per run and pass it; absent one we build it once for
  // this call. The index mirrors identitiesOverlap exactly, so merge decisions are unchanged.
  const index = opts?.identityIndex ?? (await buildIdentityIndex(deps, merchantId));
  if (hasIdentitySignal(candSignals)) {
    const matchId = index.lookup(candSignals);
    if (matchId) {
      const other = await deps.db.prospects.require(matchId);
      await mergeCandidateInto(deps, other, cand, { signals, profile, contactEmails, contactUrls, hasContactForm, competitorPromoted, isAffiliate, promotesComp, now });
      index.add(other.id, candSignals); // keep a shared index in sync for later candidates in the run
      return null; // enriched an existing prospect — not a net-new one
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
  index.add(prospect.id, candSignals); // register so later candidates in this run merge/dedup against it
  return prospect;
}

/**
 * A merchant's identity-key index: Map<hard identifier, prospectId>, built once per run so
 * ingestCandidate resolves the "is this an existing creator?" merge in O(1) instead of
 * rescanning every prospect. Keys mirror {@link identitiesOverlap}: a candidate's STRONG
 * identifiers (owned accounts, emails, domains) match an existing strong OR weak key; a
 * candidate's WEAK (page_link) account keys match only an existing STRONG key. First writer
 * wins per key so a match resolves to the earliest-ingested prospect (mirrors scan order).
 */
export interface IdentityIndex {
  lookup(signals: IdentitySignals): string | null;
  add(prospectId: string, signals: IdentitySignals): void;
}

class ProspectIdentityIndex implements IdentityIndex {
  private readonly strong = new Map<string, string>(); // strong account keys + emails + domains
  private readonly weak = new Map<string, string>(); // page_link account keys

  add(prospectId: string, s: IdentitySignals): void {
    for (const k of this.strongKeys(s)) if (!this.strong.has(k)) this.strong.set(k, prospectId);
    for (const k of s.weakAccountKeys) {
      const wk = `a:${k}`;
      if (!this.weak.has(wk)) this.weak.set(wk, prospectId);
    }
  }

  lookup(s: IdentitySignals): string | null {
    for (const k of this.strongKeys(s)) {
      const id = this.strong.get(k) ?? this.weak.get(k); // strong↔strong or strong↔weak
      if (id) return id;
    }
    for (const k of s.weakAccountKeys) {
      const id = this.strong.get(`a:${k}`); // weak↔strong only (never weak↔weak)
      if (id) return id;
    }
    return null;
  }

  private *strongKeys(s: IdentitySignals): Iterable<string> {
    for (const k of s.accountKeys) yield `a:${k}`;
    for (const e of s.emails) yield `e:${e}`;
    for (const d of s.domains) yield `d:${d}`;
  }
}

/** Build the identity-key index for a merchant from its existing prospects (once per run). */
export async function buildIdentityIndex(deps: RecruitmentDeps, merchantId: string): Promise<IdentityIndex> {
  const index = new ProspectIdentityIndex();
  const others = await deps.db.prospects.find((p) => p.merchantId === merchantId);
  for (const other of others) {
    const otherEmails = [other.email, ...(((other.evidence?.contactEmails as { email: string }[] | undefined) ?? []).map((e) => e.email))];
    index.add(other.id, identitySignalsFromProfile((other.evidence?.profile as Profile | null) ?? null, otherEmails));
  }
  return index;
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
  // Deliverability check. The EmailFinder's own verify() (e.g. Hunter) is MAILBOX-level —
  // strictly better than a domain-level MX check, which happily passes any well-formed
  // gmail.com guess. So when the finder does real verification we trust it, using the MX
  // verifier only as a cheap PRE-filter: a domain with no mail server can never receive
  // mail, so we short-circuit undeliverable BEFORE spending a paid mailbox lookup. The
  // stub finder's verify() is deterministic (not real), so we don't prefer it over MX.
  const finderVerifies = deps.emailFinder.name !== "stub-finder";
  const verify = async (email: string): Promise<{ deliverable: boolean; reason: string }> => {
    if (deps.emailVerifier) {
      const mx = await deps.emailVerifier.verify(email);
      if (!mx.deliverable) return mx; // no mail server → undeliverable; skip the paid call
      if (finderVerifies) return deps.emailFinder.verify(email); // confirm the mailbox itself
      return mx; // MX passed and no real mailbox verifier available
    }
    return deps.emailFinder.verify(email); // no MX verifier → the finder's own verify (real or stub)
  };

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
      // Trust a candidate the finder already verified at find time (Hunter stamps
      // `verified` from its verification.status) — don't pay to re-verify what it confirmed.
      // The stub always reports verified:false, so this never fires offline.
      if (c.verified) {
        chosenEmail = c.email;
        contactSource = c.source === "stub-finder" ? "pattern-guess" : c.source;
        break;
      }
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
  let lastContentAt: string | null = null;
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
      // Keep the MOST RECENT content date across the creator's accounts (activity signal).
      if (m.lastContentAt && (!lastContentAt || m.lastContentAt > lastContentAt)) lastContentAt = m.lastContentAt;
      profile.audience.source = m.source;
    }
    if (audienceReach != null) profile.audience.reach = audienceReach;
    if (audienceEngagement != null) profile.audience.engagementRate = audienceEngagement;
  }
  // Content-freshness signal: stale properties (dead >12 months) waste sends. Null recency never
  // penalizes — unknown stays unknown. Stored on evidence + surfaced as a flag for triage/UI.
  const recency = activityRecency(lastContentAt, deps.clock.now());
  const stale = isStale(lastContentAt, deps.clock.now());

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
  // Persist the resolved geo/language onto the PROSPECT row (not just the evidence profile) —
  // this is what arms the GDPR/CASL geo gate and the local-send-time gate in send()/launch.
  // Only clean ISO-shaped codes; anything else stays null rather than guessed.
  const geo = profile?.audience.primaryGeo;
  const lang = profile?.audience.language;
  return deps.db.prospects.update(prospectId, {
    email: chosenEmail,
    evidence: {
      ...(prospect.evidence ?? {}),
      contactSource,
      profile,
      contactEmails: pageEmails,
      contactUrls,
      contactForm,
      contactFormUrl,
      affiliateLinks,
      ...(lastContentAt ? { lastContentAt, activityRecency: recency, stale } : {}),
    },
    ...(geo && /^[A-Za-z]{2}$/.test(geo) ? { country: geo.toUpperCase() } : {}),
    ...(lang && /^[A-Za-z]{2}/.test(lang) ? { language: lang.slice(0, 2).toLowerCase() } : {}),
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
    scoreBreakdown: { breakdown: result.breakdown, explanation: result.explanation, confidence: result.confidence, unknownFactors: result.unknownFactors, audienceQuality: result.audienceQuality },
    state: "scored",
    updatedAt: deps.clock.now().toISOString(),
  });
}

// ---- 4. Outreach: build the first message for a campaign --------------------
// Imports for the queue/send half live here (not in the block at the top of the file) so the
// outreach and discovery fix streams, which each own one half of this module, do not both
// edit the same import lines.
import { newMessageId, unavailableMailboxSender, type MailboxSender, type SendResult } from "@affiliate/integrations";
import { stepFingerprint } from "./sequencing.js";
import { withMerchantLock } from "./merchant-lock.js";
import { inboundState, mailboxBackingOff, recordSendFailure, recordSendSuccess } from "./deliverability.js";

/**
 * Why NO outreach may be sent for this merchant right now, or null. Compliance is not
 * optional: every outreach email must carry the sender's valid physical postal address
 * (CAN-SPAM), so a merchant without one sends nothing — and is told why — instead of sending
 * mail with the address silently left out of the footer.
 */
export function outreachBlockedReason(merchant: Pick<Merchant, "physicalAddress">): string | null {
  if (!merchant.physicalAddress?.trim()) {
    return "compliance: no business postal address is set — every outreach email must carry one, so nothing is sent until it is added in Settings";
  }
  return null;
}

/** A failed transmission is retried no sooner than this (doubling per attempt, capped). */
const RETRY_BASE_MS = 3_600_000;
const RETRY_MAX_MS = 24 * 3_600_000;

/** When a message that has failed `attempts` times may next be tried. */
export function nextAttemptAfter(attempts: number, now: Date): string {
  return new Date(now.getTime() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))).toISOString();
}

/** True when a failed message is still inside its retry delay. */
export function retryNotDue(message: Pick<OutreachMessage, "nextAttemptAt">, now: Date): boolean {
  return !!message.nextAttemptAt && new Date(message.nextAttemptAt).getTime() > now.getTime();
}

function firstTouchTokens(merchant: Merchant, prospect: Prospect): Record<string, string> {
  const depth = personalizationDepth(prospect.tier);
  return {
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
}

/** Render the first-touch copy for a prospect (A/B variant pick + the merchant's plan). */
async function renderFirstTouch(
  deps: RecruitmentDeps,
  merchant: Merchant,
  prospect: Prospect,
  step: NonNullable<ReturnType<typeof firstStep>>,
): Promise<{ subject: string; body: string; variant: string }> {
  const depth = personalizationDepth(prospect.tier);
  // A/B: when the step defines variants, pick one (even, deterministic per prospect) and
  // personalize within it. The chosen variant is recorded for reply-rate-by-variant analysis.
  let effectiveStep = step;
  let abLabel: string | null = null;
  if (step.variants?.length) {
    const picked = pickVariant(step.variants, prospect.id);
    effectiveStep = { ...step, subject: picked.value.subject, body: picked.value.body };
    abLabel = `ab:v${picked.index}`;
  }
  // Personalize per the merchant's plan (template / hybrid / llm). The LLM path cites the
  // prospect's real evidence; falls back to the token template otherwise or on any failure.
  const personalized = await personalizeOutreach(deps, { merchant, prospect, step: effectiveStep, tokens: firstTouchTokens(merchant, prospect) });
  // LLM bodies are personalized per-prospect (no fixed variant to test); template sends
  // carry the A/B label so variant reply-rates are comparable.
  return { subject: personalized.subject, body: personalized.body, variant: personalized.mode === "llm" ? "llm" : abLabel ?? depth };
}

/**
 * Queue the first touch for a prospect. Runs under the merchant's send lock and is safe to
 * call twice (AUDIT-2026-10 O3): only a SCORED prospect is queued, and there is exactly one
 * first-touch row per prospect and campaign — a second run finds it and does not add another.
 *
 *  - already sent → null (and a prospect that slipped back to `scored` is put right);
 *  - a failed attempt → the SAME row is retried once its retry delay has passed: no new row,
 *    no second LLM personalization, nothing billed again (O10);
 *  - blocked by the content gate → held only while the step copy is unchanged; once the
 *    operator edits the copy it is re-rendered and released (O11).
 */
export async function queueFirstTouch(
  deps: RecruitmentDeps,
  prospectId: string,
  campaign: OutreachCampaign,
): Promise<OutreachMessage | null> {
  return withMerchantLock(deps, campaign.merchantId, () => queueFirstTouchLocked(deps, prospectId, campaign));
}

async function queueFirstTouchLocked(deps: RecruitmentDeps, prospectId: string, campaign: OutreachCampaign): Promise<OutreachMessage | null> {
  const prospect = await deps.db.prospects.require(prospectId);
  if (!prospect.email) return null;
  // A campaign only ever emails its own merchant's prospects.
  if (prospect.merchantId !== campaign.merchantId) return null;
  // Read fresh, under the lock: whoever listed this prospect as `scored` may be a run behind.
  if (prospect.state !== "scored") return null;
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
  const now = deps.clock.now();
  const nowIso = now.toISOString();
  const fingerprint = stepFingerprint(step);
  const merchant = await deps.db.merchants.require(prospect.merchantId);

  const rows = await deps.db.outreachMessages.find((m) => m.prospectId === prospectId && m.campaignId === campaign.id && m.step === step.step);
  if (rows.some((m) => m.status === "sent" || m.status === "replied")) {
    // The first touch already went out; the prospect's state lost that fact. Never send it again.
    await deps.db.prospects.update(prospectId, { state: "contacted", updatedAt: nowIso });
    return null;
  }
  if (rows.some((m) => m.status === "bounced")) return null;

  const existing = rows.find((m) => m.status === "queued") ?? rows[rows.length - 1];
  if (existing) {
    if (existing.status === "failed") {
      const copyChanged = existing.stepFingerprint !== fingerprint;
      const gateBlocked = (existing.blockedReason ?? "").startsWith("content gate");
      // A content-gate block is deterministic for a given copy: hold it until the copy changes.
      if (gateBlocked && !copyChanged) return null;
      if (!gateBlocked && !copyChanged && retryNotDue(existing, now)) return null;
      if (copyChanged) {
        const fresh = await renderFirstTouch(deps, merchant, prospect, step);
        await deps.db.outreachMessages.update(existing.id, { ...fresh, stepFingerprint: fingerprint, attempts: 0, nextAttemptAt: null });
      }
    }
    const requeued = await deps.db.outreachMessages.update(existing.id, { status: "queued", blockedReason: undefined });
    await deps.db.prospects.update(prospectId, { state: "queued", updatedAt: nowIso });
    return requeued;
  }

  const rendered = await renderFirstTouch(deps, merchant, prospect, step);
  const message: OutreachMessage = {
    id: newId("omsg"),
    prospectId,
    campaignId: campaign.id,
    step: step.step,
    variant: rendered.variant,
    subject: rendered.subject,
    body: rendered.body,
    sentAt: null,
    status: "queued",
    stepFingerprint: fingerprint,
    attempts: 0,
  };
  await deps.db.outreachMessages.insert(message);
  // LLM personalization is metered when the message is actually SENT (see send()), not here:
  // metering at queue time billed a personalization on every tick of an SMTP outage.
  await deps.db.prospects.update(prospectId, { state: "queued", updatedAt: nowIso });
  return message;
}

/** Render (without queuing) the first-touch email for a prospect — the preview/test-send. */
export async function previewOutreach(
  deps: RecruitmentDeps,
  prospectId: string,
  campaign: OutreachCampaign,
): Promise<{ subject: string; body: string; mode: "template" | "llm"; scan: ReturnType<typeof scanContent>; blockedReason: string | null } | null> {
  const prospect = await deps.db.prospects.require(prospectId);
  const step = firstStep(campaign);
  if (!step) return null;
  const merchant = await deps.db.merchants.require(prospect.merchantId);
  const rendered = await personalizeOutreach(deps, { merchant, prospect, step, tokens: firstTouchTokens(merchant, prospect) });
  // Surface the pre-send content gate — and anything that would stop the send outright — in
  // the preview, so the operator sees it before launch.
  return { ...rendered, scan: scanContent({ subject: rendered.subject, body: rendered.body }), blockedReason: outreachBlockedReason(merchant) };
}

// ---- 4b. Send a queued message as the merchant ------------------------------
/** Prospect states in which an outreach email may still go out. Anything else (replied,
 *  converted, suppressed, bounced, dead) means the conversation moved on while it waited. */
const SENDABLE_STATES: ReadonlySet<string> = new Set(["scored", "queued", "contacted", "in_sequence"]);

/**
 * Transmit one outreach message as the merchant. Runs under the merchant's send lock and
 * re-reads everything inside it (AUDIT-2026-10 O3): a message that is already sent is left
 * alone, so two overlapping runs cannot both transmit it.
 *
 * What the outcome means:
 *  - sent     → recorded, billed, the prospect advances;
 *  - bounced  → the RECIPIENT address is permanently bad: suppressed for this merchant,
 *               counted against the mailbox's daily cap and its bounce rate;
 *  - failed   → nothing was sent and nothing is recorded as sent. The prospect is NOT
 *               suppressed; the row is retried later with the same copy and Message-Id, and
 *               the mailbox is held back so an outage cannot burn through the list (O2/O10).
 */
export async function send(deps: RecruitmentDeps, messageId: string): Promise<OutreachMessage> {
  const queued = await deps.db.outreachMessages.require(messageId);
  const owner = await deps.db.prospects.require(queued.prospectId);
  return withMerchantLock(deps, owner.merchantId, () => sendLocked(deps, messageId));
}

async function sendLocked(deps: RecruitmentDeps, messageId: string): Promise<OutreachMessage> {
  const message = await deps.db.outreachMessages.require(messageId);
  // Claim check: only a queued (or retryable failed) row is transmitted.
  if (message.status !== "queued" && message.status !== "failed") return message;
  const prospect = await deps.db.prospects.require(message.prospectId);
  const campaign = await deps.db.campaigns.require(message.campaignId);
  const merchant = await deps.db.merchants.require(prospect.merchantId);
  const now0 = deps.clock.now().toISOString();
  /** Not sent, for a reason that is nobody's transport failure: record why, keep it retryable,
   *  and never leave a first-touch prospect stranded in `queued`. */
  const block = async (blockedReason: string): Promise<OutreachMessage> => {
    if (prospect.state === "queued") await deps.db.prospects.update(prospect.id, { state: "scored", updatedAt: now0 });
    return deps.db.outreachMessages.update(messageId, { status: "failed", blockedReason });
  };
  if (!prospect.email) return block("prospect has no email address");
  const toEmail = prospect.email;

  if (!SENDABLE_STATES.has(prospect.state)) {
    return deps.db.outreachMessages.update(messageId, { status: "failed", blockedReason: `not sent: prospect is ${prospect.state}` });
  }

  if (await isSuppressed(deps, prospect.merchantId, toEmail)) {
    // They opted out (the unsubscribe link, a STOP, a bounce) after this was queued. Take the
    // prospect out of the cadence too, so the next cycle does not come back to it.
    if (canTransition(prospect.state, "suppressed")) {
      await deps.db.prospects.update(prospect.id, { state: "suppressed", suppressionStatus: "suppressed", updatedAt: now0 });
    }
    return deps.db.outreachMessages.update(messageId, { status: "failed", blockedReason: "suppressed contact" });
  }

  // Geo-gate EU/Canada cold outreach (Section 8.9 — GDPR/CASL are strict/high-risk).
  // A gated geo is a permanent no-cold-email condition → the prospect exits the funnel.
  if (prospect.country && GEO_GATED.has(prospect.country.toUpperCase())) {
    await deps.db.prospects.update(prospect.id, { state: "dead", updatedAt: now0 });
    return deps.db.outreachMessages.update(messageId, { status: "failed", blockedReason: `geo-gated (${prospect.country.toUpperCase()} — GDPR/CASL)` });
  }

  // Compliance (O13): no postal address → no send, with a reason the operator can see.
  const compliance = outreachBlockedReason(merchant);
  if (compliance) return block(compliance);

  // Pre-send content gate (§16 #7): scan the personalized subject+body BEFORE it leaves. A
  // hard-block (empty field, egregious spam) fails the send with a reason for the operator to
  // fix, rather than burning domain reputation. Warnings pass through. Scans the raw personalized
  // content (the compliance footer's unsubscribe link is added after + is legitimate).
  // A blocked FIRST touch reverts the prospect to `scored` so it isn't stranded in `queued`;
  // queueFirstTouch holds it there until the step copy changes.
  const scan = scanContent({ subject: message.subject, body: message.body });
  if (!scan.ok) {
    return block(`content gate: ${scan.issues.filter((i) => i.severity === "block").map((i) => i.message).join("; ")}`);
  }

  const mailbox = campaign.mailboxId ? await deps.db.mailboxes.get(campaign.mailboxId) : null;
  // A mailbox the deliverability monitor auto-paused (status "error") must never send —
  // even when the resolver would happily build a working transport for it.
  if (mailbox && (mailbox.status === "error" || mailbox.status === "disconnected")) {
    return block(`mailbox ${mailbox.status === "error" ? "auto-paused" : "disconnected"}`);
  }
  // Nor one being held back after transport failures (callers check capacity first; this is
  // the backstop for anything that calls send() directly).
  if (mailbox && mailboxBackingOff(mailbox, deps.clock.now())) {
    return block(`mailbox is backing off until ${mailbox.sendBackoffUntil} after send failures${mailbox.lastSendError ? `: ${mailbox.lastSendError}` : ""}`);
  }

  const unsubUrl = unsubscribeLink(prospect.merchantId, prospect.email);
  // CAN-SPAM compliant footer: valid physical address (guaranteed present above) + one-click
  // unsubscribe. "Reply STOP" is offered only when replies to this mailbox are actually being
  // read: a mailbox with no working inbound path (O5) must not promise an opt-out it cannot
  // hear. The signed link always works.
  const footer = `\n\n—\n${merchant.name}\n${merchant.physicalAddress}\nUnsubscribe: ${inboundState(mailbox).working ? "reply STOP, or " : ""}${unsubUrl}`;
  // One-click List-Unsubscribe (RFC 8058) — REQUIRED by Gmail/Yahoo bulk-sender rules. The
  // POST variant lets the inbox unsubscribe the user without opening the link.
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<${unsubUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  // Thread follow-ups into the same conversation: reference the earlier steps' Message-Ids
  // (ours — the ones we stamped) so step 2+ lands as a reply, not a fresh cold email.
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  if (message.step > 1) {
    const prior = (await deps.db.outreachMessages.find(
      (m) => m.prospectId === prospect.id && m.campaignId === campaign.id && m.status === "sent" && m.step < message.step && !!m.providerMessageId,
    )).sort((a, b) => a.step - b.step);
    // Only real Message-Ids: rows sent before every rail stamped its own may hold a provider's
    // API id (Gmail) or a mock id, which must never be put in a threading header.
    const ids = prior.map((m) => m.providerMessageId!).filter((id) => /^<?[^\s<>]+@[^\s<>]+>?$/.test(id)).map((id) => (id.startsWith("<") ? id : `<${id}>`));
    if (ids.length) {
      references = ids;
      inReplyTo = ids[ids.length - 1];
    }
  }
  // Never invent a plausible-looking from domain: without a connected mailbox the send can
  // only be the dev/test mock, so use an RFC 2606 reserved address that cannot be mistaken
  // for (or delivered as) a real identity.
  const fromEmail = mailbox?.email ?? "no-reply@example.invalid";
  // OUR Message-Id, fixed before the first attempt and reused by every retry of this row: it
  // is what the reply (or the bounce) will reference, on every rail (O9).
  const ourMessageId = message.providerMessageId && message.providerMessageId.includes("@") ? message.providerMessageId : newMessageId(fromEmail);
  const attempts = (message.attempts ?? 0) + 1;
  await deps.db.outreachMessages.update(messageId, { providerMessageId: ourMessageId, attempts });

  // Send AS the merchant: resolve their connected mailbox (SMTP/Graph/Gmail). With no resolver
  // wired this is the dev/test default mailer. A resolver that THROWS yields a sender that
  // fails — it must never fall back to the default mailer, which is a mock that would record
  // mail as sent that never left (O4).
  let sender: MailboxSender;
  if (deps.mailboxResolver) {
    try {
      sender = await deps.mailboxResolver(campaign.mailboxId);
    } catch (e) {
      sender = unavailableMailboxSender(`mailbox sender could not be resolved: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  } else {
    sender = deps.mailer;
  }
  let result: SendResult;
  try {
    result = await sender.send({
      fromName: merchant.name,
      fromEmail,
      toEmail: prospect.email,
      subject: message.subject,
      body: message.body + footer,
      headers,
      messageId: ourMessageId,
      inReplyTo,
      ...(references ? { references } : {}),
    });
  } catch (e) {
    // Adapters are meant never to throw; if one does, it is a failed send, not a crashed tick.
    result = { messageId: "", status: "failed", reason: `sender error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), failure: "unknown" };
  }

  const nowDate = deps.clock.now();
  const now = nowDate.toISOString();
  // Record the outcome as ONE unit — the message row first, then the prospect, the usage and
  // the suppression rows — so a crash cannot leave "sent" without its prospect state, or a
  // bounce without its suppression. (A crash between the transport's answer and this point
  // leaves the row queued; the retry goes out under the same Message-Id.)
  return deps.db.transaction(async (tx) => {
    const txDeps: RecruitmentDeps = { ...deps, db: tx };
    if (result.status === "bounced") {
      // `sentAt` is set: a bounced message was transmitted, so it spends the mailbox's daily cap.
      const bounced = await tx.outreachMessages.update(messageId, { status: "bounced", sentAt: now, blockedReason: undefined, deliveryError: result.reason, nextAttemptAt: null });
      await suppress(txDeps, { merchantId: prospect.merchantId, email: toEmail, reason: "hard bounce", scope: "merchant" });
      await tx.prospects.update(prospect.id, { state: "bounced", suppressionStatus: "bounced", updatedAt: now });
      return bounced;
    }
    // A transport failure (outage, expired token, quota, sender/policy rejection) is NOT a send:
    // keep the row retryable after a delay, do NOT advance the prospect, do NOT bill. A failed
    // first touch returns the prospect to `scored`. Unless the failure is specific to this one
    // recipient (greylisted, mailbox full), the MAILBOX is held back too.
    if (result.status === "failed") {
      const failedRow = await tx.outreachMessages.update(messageId, {
        status: "failed",
        blockedReason: `send failed: ${result.reason ?? "transport error"}`,
        nextAttemptAt: nextAttemptAfter(attempts, nowDate),
      });
      if (prospect.state === "queued") await tx.prospects.update(prospect.id, { state: "scored", updatedAt: now });
      if (mailbox && result.failure !== "recipient") {
        await recordSendFailure(txDeps, mailbox.id, result.reason ?? "transport error", nowDate);
      }
      return failedRow;
    }

    const sent = await tx.outreachMessages.update(messageId, {
      status: "sent",
      sentAt: now,
      // Store the Message-Id that is on the wire: ours, unless the sender reports the id it
      // actually used. Never a provider-internal API id (those carry no "@").
      providerMessageId: result.messageId && result.messageId.includes("@") ? result.messageId : ourMessageId,
      blockedReason: undefined,
      nextAttemptAt: null,
    });
    const nextState = prospect.state === "queued" || prospect.state === "scored" ? "contacted" : "in_sequence";
    await tx.prospects.update(prospect.id, { state: nextState, updatedAt: now });
    await tx.usageEvents.insert({ id: newId("use"), merchantId: prospect.merchantId, kind: "send", quantity: 1, sourceId: message.id, ts: now });
    // Meter LLM personalizations for plan-tier billing — one event per LLM-written email that
    // actually went out (a row is sent at most once, so this cannot double-bill).
    if (message.variant === "llm") {
      await tx.usageEvents.insert({ id: newId("use"), merchantId: prospect.merchantId, kind: "personalization", quantity: 1, sourceId: message.id, ts: now });
    }
    if (mailbox) await recordSendSuccess(txDeps, mailbox.id);
    return sent;
  });
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

/** The signed one-click unsubscribe URL put in every outreach footer + List-Unsubscribe header. */
export function unsubscribeLink(merchantId: string, email: string): string {
  // Points at the API's real public unsubscribe endpoint. SIGNED: the endpoint rejects
  // unsigned requests, so nobody can suppress arbitrary addresses by enumerating `?e=`.
  // (`||`, not `??`: a PUBLIC_API_URL that is present but empty must not yield a relative link.)
  const base = (process.env.PUBLIC_API_URL ?? "").trim() || "http://localhost:8787";
  // The API verifies with this same helper (UNSUBSCRIBE_SECRET → JWT_SECRET; an env var that
  // is present but empty counts as unset) — signer and verifier cannot drift apart.
  const token = signUnsubscribeToken(merchantId, email, resolveUnsubscribeSecret());
  return `${base}/track/unsubscribe?m=${encodeURIComponent(merchantId)}&e=${encodeURIComponent(email)}&t=${token}`;
}
