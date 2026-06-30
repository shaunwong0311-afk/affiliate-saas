import type { Merchant, Prospect } from "@affiliate/db";
import type { Profile } from "@affiliate/core";
import type { RecruitmentDeps } from "./deps.js";
import { evidenceSummary } from "./personalization.js";

/**
 * Multichannel DM assist (OUTREACH-SPEC §6). Creators — especially micro/TikTok — often
 * reply to a DM faster than email. But cold-DM AUTOMATION is against every platform's ToS
 * and gets the merchant's account banned, so we do NOT auto-send. Instead, exactly like the
 * compliant contact-form track, we DRAFT a personalized DM, pick the best handle from the
 * identity graph, and hand the operator a deep link that opens the native composer — the
 * human presses send. The cadence (email → DM nudge → email) is orchestrated; only the DM
 * keystroke is manual. The identity graph (handles) + personalization engine make it work.
 */

// Platforms we can DM-assist, in order of preference (handle-bearing, deep-linkable first).
const DM_PRIORITY = ["instagram", "twitter", "tiktok", "telegram"];

export interface DmTarget {
  platform: string;
  handle: string;
  profileUrl: string;
  /** Deep link to start the DM. opensComposer=true opens the message box directly;
   *  false opens the profile (operator clicks "Message"). null = no link (open manually). */
  deepLink: string | null;
  opensComposer: boolean;
}

/** A deep link to the platform's DM composer (or profile). The HUMAN sends — never auto. */
export function dmDeepLink(platform: string, handle: string): { url: string | null; opensComposer: boolean } {
  const h = handle.replace(/^@/, "");
  switch (platform) {
    case "instagram":
      return { url: `https://ig.me/m/${h}`, opensComposer: true };
    case "telegram":
      return { url: `https://t.me/${h}`, opensComposer: true };
    case "twitter":
      // X needs a numeric recipient_id for a direct compose; open the profile → "Message".
      return { url: `https://x.com/${h}`, opensComposer: false };
    case "tiktok":
      return { url: `https://www.tiktok.com/@${h}`, opensComposer: false };
    default:
      return { url: null, opensComposer: false }; // youtube etc. → no DM, use email
  }
}

/** Pick the best social account in the identity graph to DM (priority then confidence). */
export function bestDmTarget(profile: Profile | null): DmTarget | null {
  if (!profile) return null;
  const candidates = profile.accounts.filter((a) => a.handle && DM_PRIORITY.includes(a.platform));
  if (!candidates.length) return null;
  candidates.sort((a, b) => DM_PRIORITY.indexOf(a.platform) - DM_PRIORITY.indexOf(b.platform) || b.confidence - a.confidence);
  const a = candidates[0]!;
  const link = dmDeepLink(a.platform, a.handle!);
  return { platform: a.platform, handle: a.handle!, profileUrl: a.url, deepLink: link.url, opensComposer: link.opensComposer };
}

export interface DmDraft {
  target: DmTarget;
  message: string;
  mode: "template" | "llm";
}

/**
 * Draft a short, casual DM for a prospect. HITL — the operator sends it. LLM when wired
 * (no links — DMs with links read as spam), else a clean template. Returns null when the
 * prospect has no DM-able social handle (use the email track instead).
 */
export async function draftDm(deps: RecruitmentDeps, merchant: Merchant, prospect: Prospect): Promise<DmDraft | null> {
  const profile = (prospect.evidence?.profile as Profile | null) ?? null;
  const target = bestDmTarget(profile);
  if (!target) return null;

  return draftDmInner(deps, merchant, prospect, target);
}

const TIER_RANK = { A: 3, B: 2, C: 1 } as const;

export interface DmFollowupTarget {
  prospectId: string;
  identity: string;
  tier: "A" | "B" | "C" | null;
  score: number | null;
  lastEmailedAt: string | null;
  daysSinceEmail: number | null;
  target: DmTarget;
}

/**
 * The high-value social-follow-up queue: HIGH-QUALITY prospects we EMAILED who haven't
 * replied — surfaced for a DM nudge on the channel they actually answer. Filters to tier
 * ≥ minTier, state contacted/in_sequence (emailed, no reply), a DM-able handle, and
 * (default) emailed at least `minDaysSinceEmail` ago so email has had time to land first.
 */
export async function dmFollowupTargets(
  deps: RecruitmentDeps,
  merchantId: string,
  opts: { minTier?: "A" | "B" | "C"; minDaysSinceEmail?: number } = {},
): Promise<DmFollowupTarget[]> {
  const minRank = TIER_RANK[opts.minTier ?? "B"];
  const minDays = opts.minDaysSinceEmail ?? 3;
  const nowMs = deps.clock.now().getTime();
  const prospects = await deps.db.prospects.find(
    (p) => p.merchantId === merchantId && (p.state === "contacted" || p.state === "in_sequence") && p.tier != null && TIER_RANK[p.tier] >= minRank,
  );

  const out: DmFollowupTarget[] = [];
  for (const p of prospects) {
    if (await deps.db.replies.findOne((r) => r.prospectId === p.id)) continue; // already replied → skip
    const target = bestDmTarget((p.evidence?.profile as Profile | null) ?? null);
    if (!target) continue; // no social handle to DM
    const sentAts = (await deps.db.outreachMessages.find((m) => m.prospectId === p.id && m.status === "sent" && !!m.sentAt)).map((m) => m.sentAt!).sort();
    const lastEmailedAt = sentAts.length ? sentAts[sentAts.length - 1]! : null;
    const daysSinceEmail = lastEmailedAt ? (nowMs - new Date(lastEmailedAt).getTime()) / 86_400_000 : null;
    if (daysSinceEmail != null && daysSinceEmail < minDays) continue; // give email time to land
    out.push({ prospectId: p.id, identity: p.identity, tier: p.tier, score: p.score, lastEmailedAt, daysSinceEmail, target });
  }
  return out.sort((a, b) => TIER_RANK[b.tier ?? "C"] - TIER_RANK[a.tier ?? "C"] || (b.score ?? 0) - (a.score ?? 0));
}

async function draftDmInner(deps: RecruitmentDeps, merchant: Merchant, prospect: Prospect, target: DmTarget): Promise<DmDraft> {
  const fallback = `Hey ${prospect.identity}! Really like your content — I run the affiliate program at ${merchant.name} (${merchant.niche ?? "our products"}) and think you'd be a great fit. Mind if I share the details?`;
  if (deps.llm.model === "deterministic-llm-v1") return { target, message: fallback, mode: "template" };

  try {
    const out = await deps.llm.complete(
      `Write a SHORT, casual ${target.platform} DM (max 55 words) recruiting this creator to ${merchant.name}'s affiliate program (${merchant.niche ?? "products"}). Reference their content naturally; end with a soft yes/no ask. Evidence: ${evidenceSummary(merchant, prospect)}. Output ONLY the message text.`,
      { system: "You write natural creator DMs in the merchant's voice. No greeting fluff, no AI tells, NO links (links in DMs read as spam).", maxTokens: 150 },
    );
    const msg = out.trim();
    return msg.length > 10 ? { target, message: msg, mode: "llm" } : { target, message: fallback, mode: "template" };
  } catch {
    return { target, message: fallback, mode: "template" };
  }
}
