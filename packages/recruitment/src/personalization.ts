import type { Tier } from "@affiliate/core";
import { renderTemplate } from "@affiliate/integrations";
import type { Merchant, Prospect, SequenceStep } from "@affiliate/db";
import type { RecruitmentDeps } from "./deps.js";

/**
 * Per-affiliate personalization (OUTREACH-SPEC §5). The merchant picks a plan, billed
 * differently; the plan + the prospect's tier decide whether a cheap LLM writes the body
 * (citing the prospect's REAL evidence — their affiliate links, the competitor they
 * promote, their platforms/reach) or we fall back to the token template. The compliance
 * envelope (footer/unsubscribe/address) is always added by the send path, never here.
 */

export type PersonalizationPlan = "template" | "hybrid" | "llm";

export function planForMerchant(merchant: Pick<Merchant, "personalizationPlan">): PersonalizationPlan {
  return merchant.personalizationPlan ?? "hybrid";
}

/** Does this prospect get an LLM-written body under the merchant's plan? */
export function usesLlm(plan: PersonalizationPlan, tier: Tier | null): boolean {
  if (plan === "llm") return true;
  if (plan === "hybrid") return tier === "A"; // spend the LLM only on the high-value tier
  return false;
}

/** A compact, factual evidence string for the LLM prompt (no invented facts). */
export function evidenceSummary(merchant: Pick<Merchant, "name" | "niche">, prospect: Prospect): string {
  const ev = (prospect.evidence ?? {}) as {
    competitorPromoted?: string | null;
    affiliateLinks?: { network: string }[];
    profile?: { accounts?: { platform: string }[]; audience?: { reach?: number | null } };
  };
  const bits: string[] = [`Creator/site: ${prospect.identity}`];
  if (prospect.siteUrl) bits.push(`site ${prospect.siteUrl}`);
  if (ev.competitorPromoted) bits.push(`already runs affiliate links for your competitor ${ev.competitorPromoted}`);
  const networks = [...new Set((ev.affiliateLinks ?? []).map((l) => l.network))].filter(Boolean).slice(0, 3);
  if (networks.length) bits.push(`runs affiliate links (${networks.join(", ")})`);
  const platforms = [...new Set((ev.profile?.accounts ?? []).map((a) => a.platform))].slice(0, 4);
  if (platforms.length) bits.push(`active on ${platforms.join(", ")}`);
  const reach = ev.profile?.audience?.reach;
  if (reach) bits.push(`audience ~${reach.toLocaleString()}`);
  return bits.join("; ");
}

export interface PersonalizedMessage {
  subject: string;
  body: string;
  mode: "template" | "llm";
}

/**
 * Parse a JSON object out of an LLM completion. Models asked for JSON still wrap it in a code
 * fence or a sentence often enough that a bare `JSON.parse` silently sent every such answer
 * down the "LLM failed" fallback. Throws when there is no object.
 */
export function parseJsonObject(out: string): Record<string, unknown> {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in completion");
  const parsed: unknown = JSON.parse(out.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("completion is not a JSON object");
  return parsed as Record<string, unknown>;
}

/**
 * Produce the subject + body for one sequence step. LLM path when the plan/tier call for it
 * AND a real LLM is wired; otherwise the deterministic token template. Always falls back
 * to the template on any LLM/parse failure (never blocks a send, never invents).
 *
 * The LLM is given the merchant's OWN copy for the step and told which step it is. It used to
 * get neither, so a "following up" or "closing the loop" step came back as another first
 * pitch that ignored what the merchant had written for it.
 */
export async function personalizeOutreach(
  deps: RecruitmentDeps,
  input: { merchant: Merchant; prospect: Prospect; step: SequenceStep; tokens: Record<string, string> },
): Promise<PersonalizedMessage> {
  const { merchant, prospect, step, tokens } = input;
  const template = (): PersonalizedMessage => ({
    subject: renderTemplate(step.subject, tokens),
    body: renderTemplate(step.body, tokens),
    mode: "template",
  });

  const plan = planForMerchant(merchant);
  const real = deps.llm.model !== "deterministic-llm-v1";
  if (!usesLlm(plan, prospect.tier) || !real) return template();

  const copy = template();
  const followUp = step.step > 1;
  const rules =
    "Reference the SPECIFIC evidence provided — never invent facts. No clichés, " +
    'no "I hope this finds you well", no AI tells. ' +
    "Keep the intent, the offer and the call to action of the merchant's own copy for this step; do not contradict or drop what it says. " +
    'Do NOT add a signature, unsubscribe, or address (the system appends those). Output JSON: {"subject": "...", "body": "..."}.';
  const system = followUp
    ? "You write a FOLLOW-UP in an affiliate-recruitment email thread, in the merchant's voice. An earlier email in this thread got no reply. " +
      "30-70 words, shorter than a first email. Do not introduce the merchant again and do not repeat the first pitch. " +
      (step.kind === "breakup" ? "This is the LAST note in the sequence: close the loop politely and leave the door open. " : "") +
      rules
    : "You write short, warm, genuine affiliate-recruitment emails in the merchant's voice. " +
      "60-110 words. End with a soft ask to share program details. " +
      rules;
  const prompt =
    `Merchant: ${merchant.name} — sells ${merchant.niche ?? "products"}.\n` +
    `Prospect evidence: ${evidenceSummary(merchant, prospect)}.\n` +
    `Sequence step ${step.step}${step.kind ? ` (${step.kind})` : ""}${followUp ? " — a follow-up to an unanswered email" : " — the first email"}.\n` +
    `The merchant's own copy for this step:\nSubject: ${copy.subject}\n${copy.body}\n\n` +
    `Write this ${followUp ? "follow-up" : "recruitment email"} as JSON {subject, body}.`;

  try {
    const out = await deps.llm.complete(prompt, { system, json: true, maxTokens: 400 });
    const parsed = parseJsonObject(out) as { subject?: string; body?: string };
    if (typeof parsed.subject === "string" && typeof parsed.body === "string" && parsed.subject.trim() && parsed.body.trim()) {
      return { subject: parsed.subject.trim(), body: parsed.body.trim(), mode: "llm" };
    }
  } catch {
    /* fall through to the template */
  }
  return template();
}
