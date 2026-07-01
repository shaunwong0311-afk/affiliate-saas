import type { Program, Offer } from "../types/program.js";
import { commissionLineFromOffer } from "./activation-email.js";

/**
 * AI-SDR reply handler — the grounded, safe autoresponder half of the two-track model
 * (OUTREACH-SPEC §16 #11). Design decisions, encoded structurally (not as prompt pleas):
 *
 *  1. KB-in-context, NOT RAG. A merchant's knowledge is tiny (a program, a few offers, a
 *     handful of FAQs), so we serialize the REAL facts and hand them to the model whole.
 *  2. Topic gate FIRST. Certain topics (rate negotiation, custom deals, legal, meetings,
 *     payment problems) ALWAYS go to a human — the gate is a hard structural guardrail, so
 *     no prompt-injection or model whim can auto-answer them.
 *  3. Grounding. The AI answers ONLY from the KB. Allow-listed structured questions
 *     (commission, cookie window, payout schedule, how-to-join) are answered DETERMINISTICALLY
 *     here (zero hallucination surface). Everything else needs KB support or it becomes a
 *     human handoff — the model is told to emit NEEDS_HUMAN rather than guess.
 *
 * This module is pure. The LLM call + handoff/notify orchestration live in the recruitment
 * reply-router; here we provide the gate, the KB assembly, the deterministic answers, and
 * the grounded prompt.
 */

export type SdrTopic =
  | "rate_negotiation"
  | "custom_deal"
  | "legal"
  | "meeting"
  | "payment_issue"
  | "commission_question"
  | "cookie_window_question"
  | "payout_question"
  | "how_to_join"
  | "product_question"
  | "general_question";

/** Topics that ALWAYS require a human — never auto-answered, whatever the model thinks. */
export const ALWAYS_HUMAN_TOPICS: readonly SdrTopic[] = ["rate_negotiation", "custom_deal", "legal", "meeting", "payment_issue"];
/** Topics answerable deterministically from the KB (no LLM, no hallucination surface). */
export const AUTO_ANSWER_TOPICS: readonly SdrTopic[] = ["commission_question", "cookie_window_question", "payout_question", "how_to_join"];

export interface TopicGateResult {
  topic: SdrTopic;
  mustBeHuman: boolean;
}

// Ordered rules — the FIRST match wins, so the human-gated + money-sensitive topics are
// checked before the softer informational ones they could otherwise be mistaken for.
const TOPIC_RULES: { topic: SdrTopic; re: RegExp }[] = [
  { topic: "payment_issue", re: /\b(did(n'?t| not) get paid|missing (payment|commission|payout)|payout (issue|problem|late|missing)|not (yet )?paid|where'?s my (money|payout|commission)|haven'?t been paid|owed)\b/i },
  { topic: "rate_negotiation", re: /\b(negotiat|better rate|higher (rate|commission|percentage|%)|increase (my )?(rate|commission|cut)|match .*(competitor|offer)|beat .*(offer|rate)|exclusive rate|more than \d+%)\b/i },
  { topic: "custom_deal", re: /\b(custom (deal|terms|arrangement|rate)|flat fee|upfront|retainer|paid (post|partnership)|sponsorship fee|guarantee|minimum guarantee|net-?\d+|bespoke)\b/i },
  { topic: "legal", re: /\b(contract|legal|attorney|lawyer|liabilit|indemnif|\bnda\b|non-?disclosure|terms of the agreement|sign(ed)? agreement|w-?9|w-?8|tax form)\b/i },
  { topic: "meeting", re: /\b(hop on|jump on|schedule a|book a (time|call|meeting)|set up a (call|meeting)|zoom|google meet|calendar|call this week|chat (this|next) week|get on a call)\b/i },
  { topic: "cookie_window_question", re: /\b(cookie|attribution window|how long (does|is) the (cookie|link|tracking)|tracking (last|window)|window .* (credit|attribut)|days .* (credit|attribut))\b/i },
  { topic: "payout_question", re: /\b(when (do|will) i (get paid|be paid)|payout (schedule|frequency|threshold|minimum|method)|how (do|often).*(paid|payout)|minimum payout|payment method|get paid out)\b/i },
  { topic: "commission_question", re: /\b(commission|how much (do|will|can) i (earn|make|get)|what'?s the (rate|payout|cut|percentage)|what rate|how much per|\d*% ?(cut|commission)?)\b/i },
  { topic: "how_to_join", re: /\b(how (do|can) i (join|sign ?up|start|get started|register|enroll)|where do i (sign|join)|join (the|your) program|how to apply|get set up)\b/i },
  { topic: "product_question", re: /\b(product|ingredient|ship(s|ping|ped)?|return policy|sizes?|in stock|restock|discount code|coupon|samples?|how does .* work)\b/i },
];

/** Classify the reply's topic and whether it is hard-gated to a human. Deterministic. */
export function topicGate(text: string): TopicGateResult {
  for (const rule of TOPIC_RULES) {
    if (rule.re.test(text)) return { topic: rule.topic, mustBeHuman: ALWAYS_HUMAN_TOPICS.includes(rule.topic) };
  }
  return { topic: "general_question", mustBeHuman: false };
}

export interface MerchantKbInput {
  merchantName: string;
  program: Pick<Program, "approvalMode" | "holdDays" | "termsUrl"> | null;
  /** Active offers; the first is treated as the default for headline facts. */
  offers: Offer[];
  faqs: { question: string; answer: string }[];
}

/** The compact, grounded fact sheet the AI-SDR is allowed to answer from. */
export interface MerchantKb {
  merchantName: string;
  commissionLine: string | null;
  cookieWindowDays: number | null;
  payoutHoldDays: number | null;
  approvalMode: string | null;
  howToJoin: string;
  termsUrl: string | null;
  faqs: { question: string; answer: string }[];
}

export function buildMerchantKb(input: MerchantKbInput): MerchantKb {
  const offer = input.offers[0] ?? null;
  const approval = input.program?.approvalMode ?? null;
  const howToJoin =
    approval === "auto"
      ? "Sign up through the program link and you're approved instantly — you'll get your tracking link and personal code right away."
      : approval === "invite_only"
        ? "This program is invite-only; if you've been invited, use the link in your invite to join."
        : "Apply through the program link; the team reviews applications and you'll get your tracking link and code once you're approved.";
  return {
    merchantName: input.merchantName,
    commissionLine: commissionLineFromOffer(offer),
    cookieWindowDays: offer?.windowDays ?? null,
    payoutHoldDays: input.program?.holdDays ?? null,
    approvalMode: approval,
    howToJoin,
    termsUrl: input.program?.termsUrl ?? null,
    faqs: input.faqs.slice(0, 25),
  };
}

/** JSON fact sheet for the grounded LLM prompt (only the facts we'll stand behind). */
export function serializeKb(kb: MerchantKb): string {
  return JSON.stringify({
    merchant: kb.merchantName,
    commission: kb.commissionLine,
    cookieWindowDays: kb.cookieWindowDays,
    payoutHoldDays: kb.payoutHoldDays,
    howToJoin: kb.howToJoin,
    terms: kb.termsUrl,
    faqs: kb.faqs,
  });
}

/**
 * Deterministic, fully-grounded answer for an allow-listed structured topic, or null when
 * the KB can't answer it (→ the caller falls back to the grounded LLM, then to a human).
 * Never fabricates: returns null rather than guessing when a fact is missing. `text` is the
 * raw reply, used to match a curated FAQ for product/general questions.
 */
export function answerFromKb(kb: MerchantKb, topic: SdrTopic, text: string): string | null {
  switch (topic) {
    case "commission_question":
      return kb.commissionLine ? `${kb.commissionLine} You can see your live earnings any time in your portal.` : null;
    case "cookie_window_question":
      return kb.cookieWindowDays != null
        ? `Our tracking window is ${kb.cookieWindowDays} days — if someone clicks your link and buys within ${kb.cookieWindowDays} days, the sale is credited to you.`
        : null;
    case "payout_question":
      return kb.payoutHoldDays != null
        ? `Commissions clear after a ${kb.payoutHoldDays}-day hold (to cover returns), then become payable on the next payout run. You can track everything in your portal statement.`
        : null;
    case "how_to_join":
      return kb.howToJoin;
    case "product_question":
    case "general_question":
      return matchFaq(kb.faqs, text);
    default:
      return null;
  }
}

/** Grounded LLM prompt: answer ONLY from the KB, else emit NEEDS_HUMAN (no guessing). */
export function buildGroundedSdrPrompt(kb: MerchantKb, question: string): { system: string; user: string } {
  return {
    system:
      "You are an affiliate-program SDR replying to a creator. Answer using ONLY the facts in the KB JSON provided. " +
      "If the KB does not contain enough to answer, reply with EXACTLY the token NEEDS_HUMAN and nothing else. " +
      "Never invent commission rates, dates, payout terms, or policies. Keep it to 2-3 warm sentences in the merchant's voice, no AI tells.",
    user: `KB:\n${serializeKb(kb)}\n\nCreator's question:\n"""${question}"""`,
  };
}

/** The token the grounded model must emit when it can't answer from the KB. */
export const NEEDS_HUMAN_TOKEN = "NEEDS_HUMAN";

/** True when a grounded-LLM answer declined (so the caller routes to a human). */
export function isNeedsHuman(llmOutput: string): boolean {
  return llmOutput.trim().toUpperCase().includes(NEEDS_HUMAN_TOKEN) || llmOutput.trim().length === 0;
}

/**
 * One-line human-readable summary of the inbound reply for the handoff packet. Deterministic
 * (the LLM can enrich it upstream); trims + collapses so an operator sees the gist at a glance.
 */
export function summarizeReply(text: string, topic: SdrTopic): string {
  const first = text.replace(/\s+/g, " ").trim().slice(0, 160);
  const label = topic.replace(/_/g, " ");
  return `${label}: “${first}${text.length > 160 ? "…" : ""}”`;
}

/**
 * Best-effort FAQ match by keyword (content-word) overlap between the reply and each curated
 * question. Returns the answer only above a confidence floor — below it, null (don't force-fit
 * a wrong FAQ; the caller falls through to the grounded LLM, then a human).
 */
function matchFaq(faqs: { question: string; answer: string }[], text: string): string | null {
  const q = keywords(text);
  if (q.size === 0) return null;
  let best: { answer: string; score: number } | null = null;
  for (const faq of faqs) {
    const fq = keywords(faq.question);
    if (fq.size === 0) continue;
    let overlap = 0;
    for (const w of fq) if (q.has(w)) overlap++;
    const score = overlap / fq.size; // fraction of the FAQ's keywords the reply mentions
    if (overlap >= 2 && score >= 0.5 && (!best || score > best.score)) best = { answer: faq.answer, score };
  }
  return best?.answer ?? null;
}

const STOPWORDS = new Set(["the", "a", "an", "is", "are", "do", "does", "did", "you", "your", "i", "we", "to", "of", "and", "or", "for", "on", "in", "how", "what", "when", "where", "can", "will", "my", "me", "with", "it", "this", "that", "have", "has", "get", "any", "there", "be", "am"]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}
