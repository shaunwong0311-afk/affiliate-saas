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
