import {
  newId,
  type Tier,
  topicGate,
  buildMerchantKb,
  answerFromKb,
  buildGroundedSdrPrompt,
  isNeedsHuman,
  summarizeReply,
  AUTO_ANSWER_TOPICS,
  type SdrTopic,
  type MerchantKb,
} from "@affiliate/core";
import { classifyReply, type InboundReply } from "@affiliate/integrations";
import type { Meeting, Reply, Handoff, Prospect } from "@affiliate/db";
import type { RecruitmentDeps } from "./deps.js";
import { suppress } from "./suppression.js";

/**
 * Two-track reply routing (the agreed model). The funnel's job is to get a warm
 * "yes, let's talk" and then split by value:
 *
 *  - Long-tail (below the meeting tier): AI-SDR answers routine questions and
 *    drops a self-serve signup link. Fully automated, no human, no meeting.
 *  - High-value (A-tier / at-or-above the meeting tier): AI-SDR qualifies, books a
 *    meeting on the merchant's calendar, and assigns an owner. Human closes with
 *    negotiated terms.
 *
 * Revenue is hyper-concentrated, so human time goes only where it converts.
 */

export type ReplyAction =
  | "suppress"
  | "dead"
  | "snooze"
  | "self_serve"
  | "meeting_booked"
  | "ai_sdr"
  | "handoff"
  | "review";

export interface ReplyOutcome {
  reply: Reply;
  classification: Reply["classification"];
  action: ReplyAction;
  /** Self-serve signup link (long-tail track). */
  signupUrl?: string;
  /** AI-SDR generated answer to a question (grounded in the merchant KB). */
  answer?: string;
  /** Whether a grounded answer is cleared for automatic sending (autopilot + allow-listed only). */
  autoSend?: boolean;
  /** Booked meeting (managed track). */
  meeting?: Meeting;
  bookingUrl?: string;
  /** Human-handoff packet, when a person is needed (gated topic, ungrounded, or approval). */
  handoff?: Handoff;
  /** True when this reply is routed to a human rather than auto-handled. */
  needsHuman?: boolean;
  /** The AI-SDR topic classification (for observability). */
  topic?: SdrTopic;
}

const tierRank: Record<Tier, number> = { A: 3, B: 2, C: 1 };

export interface RouteOptions {
  /** Tier at/above which an interested reply books a meeting (managed track). */
  meetingTier?: Tier;
  /** Base URL for self-serve signup links. */
  signupBaseUrl?: string;
  /**
   * AI-SDR autonomy. "hitl" (default): grounded answers become a suggested reply on a handoff
   * for a human to approve; "autopilot": deterministic allow-listed answers are cleared to
   * auto-send. Topic-gated/ungrounded replies always go to a human regardless of mode.
   */
  aiSdrMode?: "hitl" | "autopilot";
}

export async function routeReply(deps: RecruitmentDeps, prospectId: string, raw: string, opts: RouteOptions = {}): Promise<ReplyOutcome> {
  const prospect = await deps.db.prospects.require(prospectId);
  const now = deps.clock.now().toISOString();
  const classification = await classify(deps, raw);

  const reply: Reply = { id: newId("rep"), prospectId, raw, classification, handledBy: null, ts: now };
  await deps.db.replies.insert(reply);

  if (classification === "unsubscribe") {
    if (prospect.email) await suppress(deps, { merchantId: prospect.merchantId, email: prospect.email, reason: "unsubscribe", scope: "global" });
    await deps.db.prospects.update(prospectId, { state: "suppressed", suppressionStatus: "suppressed", updatedAt: now });
    return { reply, classification, action: "suppress" };
  }
  if (classification === "not_interested") {
    await deps.db.prospects.update(prospectId, { state: "dead", updatedAt: now });
    return { reply, classification, action: "dead" };
  }
  if (classification === "out_of_office") {
    return { reply, classification, action: "snooze" };
  }
  if (classification !== "interested" && classification !== "question") {
    // Unknown intent → human review (the high-value HITL checkpoint).
    await deps.db.prospects.update(prospectId, { state: "replied", updatedAt: now });
    return { reply, classification, action: "review" };
  }

  await deps.db.prospects.update(prospectId, { state: "replied", updatedAt: now });

  const meetingTier = opts.meetingTier ?? "A";
  const isHighValue = prospect.tier != null && tierRank[prospect.tier] >= tierRank[meetingTier];

  if (isHighValue) {
    // Managed track: qualify, book a meeting, assign an owner.
    const owner = await deps.db.merchantUsers.findOne((u) => u.merchantId === prospect.merchantId && u.role === "owner");
    let bookingRef: string | null = null;
    let bookingUrl: string | null = null;
    if (deps.calendar) {
      const booking = await deps.calendar.createBookingLink({
        merchantId: prospect.merchantId,
        prospectId,
        prospectName: prospect.identity,
        ownerEmail: owner?.email ?? null,
      });
      bookingRef = booking.bookingRef;
      bookingUrl = booking.bookingUrl;
    }
    const meeting: Meeting = {
      id: newId("mtg"),
      merchantId: prospect.merchantId,
      prospectId,
      ownerUserId: owner?.userId ?? null,
      scheduledAt: null,
      status: bookingUrl ? "requested" : "requested",
      bookingRef,
      bookingUrl,
      notes: `Warm ${classification} reply from an A-tier prospect.`,
      createdAt: now,
    };
    await deps.db.meetings.insert(meeting);
    // A warm high-value reply is the most time-sensitive thing in the funnel — also drop it
    // in the operator handoff queue + push (A-tier = high urgency) so it never goes cold.
    const handoff = await createHandoff(deps, {
      prospect,
      reply,
      topic: "meeting",
      intent: classification,
      reason: "high_value",
      summary: summarizeReply(raw, "meeting"),
      suggestedReply: null,
    });
    return { reply, classification, action: "meeting_booked", meeting, bookingUrl: bookingUrl ?? undefined, handoff, needsHuman: true };
  }

  // Long-tail self-serve track — topic-gate FIRST, then a grounded AI-SDR answer.
  const signupUrl = `${opts.signupBaseUrl ?? "https://app.vantage.dev/join"}/${prospect.merchantId.slice(-6)}?p=${prospectId.slice(-8)}`;
  const gate = topicGate(raw);
  if (gate.mustBeHuman) {
    // Rate negotiation / custom deal / legal / meeting / payment issue → always a human.
    const handoff = await createHandoff(deps, {
      prospect,
      reply,
      topic: gate.topic,
      intent: classification,
      reason: "gated_topic",
      summary: summarizeReply(raw, gate.topic),
      suggestedReply: null,
    });
    return { reply, classification, action: "handoff", handoff, needsHuman: true, topic: gate.topic };
  }
  // Answer if it's phrased as a question OR carries a specific answerable topic — the keyword
  // classifier tags "what's your commission?" as *interested*, so we can't gate on that alone.
  if (classification === "question" || gate.topic !== "general_question") {
    return answerQuestion(deps, prospect, reply, raw, gate.topic, signupUrl, opts);
  }
  // Pure interested with nothing to answer → straight to self-serve signup.
  return { reply, classification, action: "self_serve", signupUrl, topic: gate.topic };
}

/**
 * Grounded AI-SDR answer for a long-tail question. Tries a DETERMINISTIC KB answer first
 * (allow-listed structured topics — zero hallucination surface), then a grounded LLM for
 * open product/general questions (told to emit NEEDS_HUMAN rather than guess). No grounded
 * answer → human handoff. A grounded answer is auto-send-cleared only in autopilot mode AND
 * only for the deterministic allow-list; otherwise it's queued as a suggested reply.
 */
async function answerQuestion(
  deps: RecruitmentDeps,
  prospect: Prospect,
  reply: Reply,
  raw: string,
  topic: SdrTopic,
  signupUrl: string,
  opts: RouteOptions,
): Promise<ReplyOutcome> {
  const kb = await loadMerchantKb(deps, prospect.merchantId);
  let answer = answerFromKb(kb, topic, raw);
  let deterministic = answer != null;

  if (!answer && (topic === "general_question" || topic === "product_question") && deps.llm.model !== "deterministic-llm-v1") {
    const prompt = buildGroundedSdrPrompt(kb, raw);
    try {
      const out = await deps.llm.complete(prompt.user, { system: prompt.system, maxTokens: 256 });
      if (!isNeedsHuman(out)) {
        answer = out.trim();
        deterministic = false;
      }
    } catch {
      /* fall through to a human handoff */
    }
  }

  if (!answer) {
    const handoff = await createHandoff(deps, { prospect, reply, topic, intent: reply.classification, reason: "ungrounded", summary: summarizeReply(raw, topic), suggestedReply: null });
    return { reply, classification: reply.classification, action: "handoff", handoff, needsHuman: true, topic };
  }

  const mode = opts.aiSdrMode ?? "hitl";
  // Autopilot only auto-sends the deterministic, allow-listed answers — never a generative one.
  if (mode === "autopilot" && deterministic && AUTO_ANSWER_TOPICS.includes(topic)) {
    return { reply, classification: reply.classification, action: "ai_sdr", answer, autoSend: true, signupUrl, topic };
  }
  // HITL (default) or a generative answer → queue for a human to approve + send.
  const handoff = await createHandoff(deps, { prospect, reply, topic, intent: reply.classification, reason: "approval", summary: summarizeReply(raw, topic), suggestedReply: answer });
  return { reply, classification: reply.classification, action: "ai_sdr", answer, autoSend: false, handoff, needsHuman: true, signupUrl, topic };
}

/** Assemble the grounded merchant KB from the real Program/Offer facts + curated FAQs. */
async function loadMerchantKb(deps: RecruitmentDeps, merchantId: string): Promise<MerchantKb> {
  const merchant = await deps.db.merchants.get(merchantId);
  const programs = await deps.db.programs.find((p) => p.merchantId === merchantId);
  const program = programs.find((p) => p.status === "active") ?? programs[0] ?? null;
  const offers = program ? await deps.db.offers.find((o) => o.programId === program.id && o.status === "active") : [];
  const faqs = await deps.db.merchantFaqs.find((f) => f.merchantId === merchantId);
  return buildMerchantKb({
    merchantName: merchant?.name ?? "the brand",
    program: program ? { approvalMode: program.approvalMode, holdDays: program.holdDays, termsUrl: program.termsUrl } : null,
    offers,
    faqs: faqs.map((f) => ({ question: f.question, answer: f.answer })),
  });
}

/** Create + persist a handoff packet and fire the push notifier (best-effort). */
async function createHandoff(
  deps: RecruitmentDeps,
  args: {
    prospect: Prospect;
    reply: Reply | null;
    topic: SdrTopic;
    intent: Reply["classification"];
    reason: Handoff["reason"];
    summary: string;
    suggestedReply: string | null;
  },
): Promise<Handoff> {
  const now = deps.clock.now().toISOString();
  const handoff: Handoff = {
    id: newId("ho"),
    merchantId: args.prospect.merchantId,
    prospectId: args.prospect.id,
    replyId: args.reply?.id ?? null,
    topic: args.topic,
    intent: args.intent,
    tier: args.prospect.tier ?? null,
    reason: args.reason,
    summary: args.summary,
    suggestedReply: args.suggestedReply,
    transcript: args.reply?.raw ?? "",
    status: "open",
    assignedUserId: null,
    createdAt: now,
    resolvedAt: null,
  };
  await deps.db.handoffs.insert(handoff);
  if (deps.notifier) {
    await deps.notifier
      .notify({
        merchantId: handoff.merchantId,
        handoffId: handoff.id,
        tier: handoff.tier,
        topic: handoff.topic,
        prospectName: args.prospect.identity,
        summary: handoff.summary,
        urgency: handoff.tier === "A" ? "high" : "normal",
      })
      .catch(() => {});
  }
  return handoff;
}

/**
 * Bridge an INBOUND email (from an IMAP poll or a Graph/ESP webhook) to the reply
 * router: match the sender to a prospect and route it. This is what makes replies
 * stop the sequence + drive the two-track handoff automatically — without it the
 * engine keeps emailing people who already answered.
 */
export async function processInboundReply(
  deps: RecruitmentDeps,
  inbound: InboundReply,
  opts: RouteOptions = {},
): Promise<{ matched: boolean; prospectId?: string; outcome?: ReplyOutcome }> {
  const from = inbound.fromEmail.toLowerCase().trim();
  if (!from) return { matched: false };
  // Match by the prospect's contact email. (Prefer the most recently updated when an
  // address was reused across prospects.)
  const candidates = await deps.db.prospects.find((p) => (p.email ?? "").toLowerCase() === from);
  const prospect = candidates.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  if (!prospect) return { matched: false };
  const outcome = await routeReply(deps, prospect.id, inbound.body, opts);
  return { matched: true, prospectId: prospect.id, outcome };
}

/**
 * Poll every connected mailbox for new inbound replies and route them (the SMTP-rail
 * automation loop; the webhook path is the push equivalent). For each mailbox: pull via
 * `deps.replyPoller` (loads IMAP creds, fetches mail newer than the mailbox cursor without
 * mutating flags), dedup by Message-Id (so the day-granular IMAP window can't double-route),
 * route through `processInboundReply` with the merchant's own meeting tier, stamp the reply's
 * `inboundMessageId`, then advance the mailbox cursor. Safe to call every scheduler tick.
 */
export async function ingestReplies(
  deps: RecruitmentDeps,
  opts: { signupBaseUrl?: string; merchantId?: string } = {},
): Promise<{ mailboxes: number; polled: number; matched: number }> {
  if (!deps.replyPoller) return { mailboxes: 0, polled: 0, matched: 0 };
  const mailboxes = await deps.db.mailboxes.find(
    (m) => m.status !== "disconnected" && !!m.credentialsRef && (!opts.merchantId || m.merchantId === opts.merchantId),
  );
  const routeOptsByMerchant = new Map<string, RouteOptions>();
  let polled = 0;
  let matched = 0;
  let mailboxesPolled = 0;
  for (const mailbox of mailboxes) {
    const pollStart = deps.clock.now().toISOString();
    let replies;
    try {
      replies = await deps.replyPoller(mailbox);
    } catch {
      continue; // isolate one mailbox's transport failure from the rest
    }
    mailboxesPolled++;
    if (!routeOptsByMerchant.has(mailbox.merchantId)) {
      const state = await deps.db.automationStates.get(mailbox.merchantId);
      routeOptsByMerchant.set(mailbox.merchantId, {
        meetingTier: (state?.meetingTier as Tier) ?? "A",
        aiSdrMode: state?.aiSdrMode ?? "hitl",
        signupBaseUrl: opts.signupBaseUrl,
      });
    }
    const routeOpts = routeOptsByMerchant.get(mailbox.merchantId)!;
    for (const inbound of replies) {
      polled++;
      if (inbound.messageId) {
        const seen = await deps.db.replies.findOne((r) => r.inboundMessageId === inbound.messageId);
        if (seen) continue;
      }
      const res = await processInboundReply(deps, inbound, routeOpts);
      if (res.matched && res.outcome) {
        matched++;
        if (inbound.messageId) await deps.db.replies.update(res.outcome.reply.id, { inboundMessageId: inbound.messageId });
      }
    }
    // Advance the cursor to the poll start (a small look-back overlap next time is
    // harmless — Message-Id dedup absorbs it, and it guards against clock skew).
    await deps.db.mailboxes.update(mailbox.id, { lastPolledAt: pollStart });
  }
  return { mailboxes: mailboxesPolled, polled, matched };
}

/** Use the real LLM for intent when available; fall back to the keyword classifier. */
async function classify(deps: RecruitmentDeps, raw: string): Promise<Reply["classification"]> {
  if (deps.llm.model === "deterministic-llm-v1") {
    return classifyReply(raw) as Reply["classification"];
  }
  try {
    const out = await deps.llm.complete(
      `Classify the intent of this email reply as exactly one of: interested, question, not_interested, out_of_office, unsubscribe, unknown.\n\nReply:\n"""${raw}"""\n\nReturn JSON: {"classification": "..."}`,
      { json: true, maxTokens: 64 },
    );
    const parsed = JSON.parse(out) as { classification?: string };
    const c = parsed.classification as Reply["classification"];
    return c ?? (classifyReply(raw) as Reply["classification"]);
  } catch {
    return classifyReply(raw) as Reply["classification"];
  }
}
