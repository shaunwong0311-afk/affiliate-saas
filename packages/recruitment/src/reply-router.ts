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
  /** Base URL for self-serve signup links (the web app origin; falls back to a relative path). */
  signupBaseUrl?: string;
  /**
   * AI-SDR autonomy. "hitl" (default): grounded answers become a suggested reply on a handoff
   * for a human to approve; "autopilot": deterministic allow-listed answers are cleared to
   * auto-send. Topic-gated/ungrounded replies always go to a human regardless of mode.
   */
  aiSdrMode?: "hitl" | "autopilot";
  /** Provider Message-Id of the inbound email — stamped on the Reply at insert for dedup. */
  inboundMessageId?: string;
}

/** Public self-serve join link: the FULL merchant id against the web app's public join page. */
export function buildSignupUrl(baseUrl: string | undefined, merchantId: string, prospectId: string): string {
  const base = (baseUrl ?? "").replace(/\/$/, "");
  return `${base}/#/join/${merchantId}?p=${prospectId}`;
}

/** How long an out-of-office reply pauses the sequence when no return date is parseable. */
const DEFAULT_SNOOZE_DAYS = 7;

export async function routeReply(deps: RecruitmentDeps, prospectId: string, raw: string, opts: RouteOptions = {}): Promise<ReplyOutcome> {
  const prospect = await deps.db.prospects.require(prospectId);
  const now = deps.clock.now().toISOString();
  // An empty extraction (all-quoted email, stripped footer) is UNCLASSIFIABLE — route it to a
  // human instead of guessing off boilerplate. Never classify raw fallbacks.
  const classification = raw.trim() ? await classify(deps, raw) : ("unknown" as Reply["classification"]);

  const reply: Reply = { id: newId("rep"), prospectId, raw, classification, handledBy: null, ts: now, ...(opts.inboundMessageId ? { inboundMessageId: opts.inboundMessageId } : {}) };
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
    // A real snooze: pause the cadence until they're back (parse "away/back until <date>" when
    // present, else a default week) — advanceSequences skips snoozed prospects.
    const until = parseReturnDate(raw, deps.clock.now()) ?? new Date(deps.clock.now().getTime() + DEFAULT_SNOOZE_DAYS * 86_400_000);
    await deps.db.prospects.update(prospectId, { snoozedUntil: until.toISOString(), updatedAt: now });
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
  const signupUrl = buildSignupUrl(opts.signupBaseUrl ?? deps.publicAppUrl, prospect.merchantId, prospectId);
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
  // Pure interested with nothing to answer → self-serve signup. Until the outbound-reply
  // transport auto-sends, a human must actually deliver the link — queue a SENDABLE draft
  // on the handoff board so "sign me up!" never dead-ends in silence.
  const handoff = await createHandoff(deps, {
    prospect,
    reply,
    topic: gate.topic,
    intent: classification,
    reason: "approval",
    summary: summarizeReply(raw, gate.topic),
    suggestedReply: `Amazing — welcome aboard! You can join and grab your tracking link + personal code right here: ${signupUrl}\n\nAny questions, just reply. Excited to work together!`,
  });
  return { reply, classification, action: "self_serve", signupUrl, handoff, needsHuman: true, topic: gate.topic };
}

/** Best-effort "away until <date>" parser for OOO snoozes. Null when nothing parseable. */
function parseReturnDate(raw: string, now: Date): Date | null {
  const m = raw.match(/\b(?:until|back on|returning(?: on)?|return(?: on)?)\s+([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i);
  if (!m) return null;
  const parsed = new Date(`${m[1]} ${now.getUTCFullYear()}`);
  const candidate = Number.isNaN(parsed.getTime()) ? new Date(m[1]!) : parsed;
  if (Number.isNaN(candidate.getTime())) return null;
  // A date in the past means it parsed into the wrong year — roll forward.
  if (candidate.getTime() < now.getTime()) candidate.setUTCFullYear(candidate.getUTCFullYear() + 1);
  // Cap: never snooze more than 60 days on a parsed date (mis-parses shouldn't kill a lead).
  const cap = now.getTime() + 60 * 86_400_000;
  return candidate.getTime() > cap ? null : candidate;
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
  // "How do I join?" must actually contain the join link, not just describe one.
  if (topic === "how_to_join") answer = `${answer}\n\nJoin here: ${signupUrl}`;

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
 * Actually SEND a reply to a prospect as the merchant (the in-product "send" the Handoffs
 * queue offers, and the transport autopilot answers use once graduated). Resolves the
 * campaign mailbox, threads via the inbound Reply's Message-Id, and records the sent message.
 * Returns null when it can't send (no email, no resolver, transport failure surfaced in .reason).
 */
export async function sendReplyToProspect(
  deps: RecruitmentDeps,
  args: { prospectId: string; body: string; inReplyToMessageId?: string | null; subject?: string },
): Promise<{ sent: boolean; reason?: string; messageId?: string }> {
  const prospect = await deps.db.prospects.require(args.prospectId);
  if (!prospect.email) return { sent: false, reason: "prospect has no email" };
  const merchant = await deps.db.merchants.require(prospect.merchantId);

  // Resolve the mailbox from the prospect's most recent OUTBOUND message's campaign.
  const sentMsgs = (await deps.db.outreachMessages.find((m) => m.prospectId === prospect.id && (m.status === "sent" || m.status === "replied"))).sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""));
  const lastOut = sentMsgs[0];
  const campaign = lastOut ? await deps.db.campaigns.get(lastOut.campaignId) : null;
  const mailboxId = campaign?.mailboxId ?? null;
  const mailbox = mailboxId ? await deps.db.mailboxes.get(mailboxId) : null;
  const sender = deps.mailboxResolver ? await deps.mailboxResolver(mailboxId).catch(() => deps.mailer) : deps.mailer;

  // Thread onto the creator's inbound message (so it lands in-conversation).
  const inReplyTo = args.inReplyToMessageId ?? undefined;
  const subject = args.subject ?? (lastOut ? `Re: ${lastOut.subject.replace(/^(re|fwd):\s*/i, "")}` : `Re: ${merchant.name}`);
  const result = await sender.send({
    fromName: merchant.name,
    fromEmail: mailbox?.email ?? "no-reply@example.invalid",
    toEmail: prospect.email,
    subject,
    body: args.body,
    ...(inReplyTo ? { inReplyTo } : {}),
  });
  if (result.status !== "sent") return { sent: false, reason: result.reason ?? "send failed" };

  const now = deps.clock.now().toISOString();
  await deps.db.outreachMessages.insert({
    id: newId("omsg"),
    prospectId: prospect.id,
    campaignId: campaign?.id ?? "manual",
    step: (lastOut?.step ?? 0) + 100, // reply steps sit above sequence steps
    variant: "reply",
    subject,
    body: args.body,
    sentAt: now,
    status: "sent",
    providerMessageId: result.messageId || undefined,
  });
  return { sent: true, messageId: result.messageId };
}

/** Prospect states that can plausibly be replying to OUR outreach. A prospect we never
 * contacted sending us mail is inbox noise (their newsletter, unrelated business), not a reply. */
const REPLYABLE_STATES = new Set(["queued", "contacted", "in_sequence", "replied"]);

export interface ProcessInboundOptions extends RouteOptions {
  /** Scope prospect matching to ONE merchant (the mailbox's owner). Without it, a reply to
   * merchant A's mailbox could route to merchant B's prospect for the same creator. */
  merchantId?: string;
}

/**
 * Bridge an INBOUND email (from an IMAP poll or a Graph/ESP webhook) to the reply
 * router: match the sender to a prospect and route it. This is what makes replies
 * stop the sequence + drive the two-track handoff automatically — without it the
 * engine keeps emailing people who already answered.
 *
 * Safety rails (all inbound paths go through here):
 *  - tenant scoping (opts.merchantId) — never route across merchants;
 *  - Message-Id dedup — provider webhook retries and IMAP window overlap can't double-route;
 *  - outreach correlation — a mail that references a Message-Id we know is a reply even out
 *    of state; otherwise the prospect must be in a contacted-ish state (their newsletter or
 *    unrelated correspondence must never suppress/route them).
 */
export async function processInboundReply(
  deps: RecruitmentDeps,
  inbound: InboundReply,
  opts: ProcessInboundOptions = {},
): Promise<{ matched: boolean; prospectId?: string; outcome?: ReplyOutcome; ignoredReason?: string }> {
  const from = inbound.fromEmail.toLowerCase().trim();
  if (!from) return { matched: false };

  // Dedup FIRST (centralized here so every path — IMAP, HMAC webhook, public webhook — gets it).
  if (inbound.messageId) {
    const seen = await deps.db.replies.findOne((r) => r.inboundMessageId === inbound.messageId);
    if (seen) return { matched: false, ignoredReason: "duplicate message id" };
  }

  // Match by the prospect's contact email, scoped to the owning merchant when known.
  // (Prefer the most recently updated when an address was reused across prospects.)
  const candidates = await deps.db.prospects.find(
    (p) => (p.email ?? "").toLowerCase() === from && (!opts.merchantId || p.merchantId === opts.merchantId),
  );
  const prospect = candidates.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  if (!prospect) return { matched: false };

  // Outreach correlation: strong when the mail references one of OUR sent Message-Ids.
  let correlated = false;
  const refs = `${inbound.inReplyTo ?? ""} ${inbound.references ?? ""}`.trim();
  if (refs) {
    const sent = await deps.db.outreachMessages.find((m) => m.prospectId === prospect.id && !!m.providerMessageId);
    correlated = sent.some((m) => refs.includes(m.providerMessageId!.replace(/^<|>$/g, "")));
  }
  if (!correlated && !REPLYABLE_STATES.has(prospect.state)) {
    return { matched: false, ignoredReason: `prospect never contacted (state ${prospect.state}) and mail references none of our messages` };
  }

  const outcome = await routeReply(deps, prospect.id, inbound.body, { ...opts, inboundMessageId: inbound.messageId || undefined });
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
        signupBaseUrl: opts.signupBaseUrl ?? deps.publicAppUrl,
      });
    }
    const routeOpts = routeOptsByMerchant.get(mailbox.merchantId)!;
    for (const inbound of replies) {
      polled++;
      // processInboundReply centralizes dedup (by Message-Id), tenant scoping (this mailbox's
      // merchant), and the outreach-correlation/state guard.
      const res = await processInboundReply(deps, inbound, { ...routeOpts, merchantId: mailbox.merchantId });
      if (res.matched && res.outcome) matched++;
    }
    // Advance the cursor to the poll start (a small look-back overlap next time is
    // harmless — Message-Id dedup absorbs it, and it guards against clock skew).
    await deps.db.mailboxes.update(mailbox.id, { lastPolledAt: pollStart });
  }
  return { mailboxes: mailboxesPolled, polled, matched };
}

/** Use the real LLM for intent when available; fall back to the keyword classifier. */
async function classify(deps: RecruitmentDeps, raw: string): Promise<Reply["classification"]> {
  // Deterministic opt-out FIRST — "STOP" must unsubscribe no matter what any model says.
  const firstLine = raw.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (/^(stop|unsubscribe)[.!]?$/i.test(firstLine)) return "unsubscribe";
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
