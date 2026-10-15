import {
  newId,
  type Tier,
  topicGate,
  buildMerchantKb,
  answerFromKb,
  buildGroundedSdrPrompt,
  isNeedsHuman,
  summarizeReply,
  canTransition,
  AUTO_ANSWER_TOPICS,
  type SdrTopic,
  type MerchantKb,
} from "@affiliate/core";
import { classifyReply, parseAddress, newMessageId, unavailableMailboxSender, type InboundReply, type MailboxSender, type SendResult } from "@affiliate/integrations";
import type { Meeting, Reply, Handoff, Prospect, OutreachMessage } from "@affiliate/db";
import { loggerOf, type RecruitmentDeps } from "./deps.js";
import { isSuppressed, suppress } from "./suppression.js";
import { withKeyLock, withMerchantLock } from "./merchant-lock.js";
import { outreachBlockedReason } from "./pipeline.js";
import { parseJsonObject } from "./personalization.js";
import { recordSendFailure, recordSendSuccess } from "./deliverability.js";

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
  /**
   * True when the answer WAS sent automatically (autopilot + a deterministic allow-listed
   * answer + an email to reply to + a transport that accepted it). False/absent otherwise —
   * and then a handoff carries the answer for a person to send. Never "cleared but unsent".
   */
  autoSend?: boolean;
  /** Why autopilot could not send its answer (the handoff was created instead). */
  autoSendError?: string;
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
   * for a human to approve; "autopilot": deterministic allow-listed answers to an EMAILED
   * reply are sent through the reply transport. Everything else — a generative answer, a
   * gated/ungrounded topic, a reply with no email to answer, a failed send — goes to a human.
   */
  aiSdrMode?: "hitl" | "autopilot";
  /** Provider Message-Id of the inbound email — stamped on the Reply at insert for dedup. */
  inboundMessageId?: string;
  /**
   * Whether this text is known to answer OUR outreach. True (the default) for a reply an
   * operator pasted or one that references a Message-Id we sent; false for mail that merely
   * comes from a contacted prospect's address. An uncorrelated message is never grounds for a
   * suppression — it goes to a person.
   */
  correlated?: boolean;
  /** The address the reply came from, when it is not the address we wrote to (an alias). */
  replyFrom?: string;
  /** The reply arrived by email and can be answered in-thread (enables autopilot sending). */
  canAutoSend?: boolean;
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

  const reply: Reply = {
    id: newId("rep"),
    prospectId,
    raw,
    classification,
    handledBy: null,
    ts: now,
    ...(opts.inboundMessageId ? { inboundMessageId: opts.inboundMessageId } : {}),
    ...(opts.replyFrom ? { fromEmail: opts.replyFrom } : {}),
  };
  await deps.db.replies.insert(reply);

  /** Move the prospect, but never OUT of a state a reply must not undo (converted, suppressed,
   *  bounced): a "thanks!" from a recruit who already joined is not a new lead. */
  const moveTo = async (state: Prospect["state"], extra: Partial<Prospect> = {}): Promise<void> => {
    const frozen = prospect.state === "converted" || prospect.state === "suppressed" || prospect.state === "bounced";
    await deps.db.prospects.update(prospectId, { ...(frozen ? {} : { state }), ...extra, updatedAt: now });
  };

  if (classification === "unsubscribe") {
    if (opts.correlated === false) {
      // Wording alone, in mail we cannot tie to our outreach, never suppresses anyone (their
      // own newsletter used to). It still stops the sequence — a person decides the rest.
      await moveTo("replied");
      return { reply, classification, action: "review", needsHuman: true };
    }
    // Suppress the address we write to — and the alias they answered from, if different.
    for (const email of new Set([prospect.email, opts.replyFrom].filter((e): e is string => !!e).map((e) => e.toLowerCase()))) {
      await suppress(deps, { merchantId: prospect.merchantId, email, reason: "unsubscribe", scope: "global" });
    }
    await moveTo("suppressed", { suppressionStatus: "suppressed" });
    return { reply, classification, action: "suppress" };
  }
  if (classification === "not_interested") {
    await moveTo("dead");
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
    await moveTo("replied");
    return { reply, classification, action: "review" };
  }

  await moveTo("replied");

  const meetingTier = opts.meetingTier ?? "A";
  const isHighValue = prospect.tier != null && tierRank[prospect.tier] >= tierRank[meetingTier];

  if (isHighValue) {
    // Managed track: qualify, book a meeting, assign an owner.
    const owner = await deps.db.merchantUsers.findOne((u) => u.merchantId === prospect.merchantId && u.role === "owner");
    let bookingRef: string | null = null;
    let bookingUrl: string | null = null;
    // Prefer the merchant's OWN scheduling link (real, pasted at onboarding). Only fall back
    // to a calendar adapter when one is genuinely wired — never fabricate a booking URL.
    const merchant = await deps.db.merchants.get(prospect.merchantId);
    if (merchant?.bookingUrl) {
      bookingUrl = merchant.bookingUrl;
      bookingRef = "merchant_link";
    } else if (deps.calendar && deps.calendar.provider !== "stub") {
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
  // Pure interested with nothing to answer → self-serve signup. A human delivers the link:
  // queue a SENDABLE draft on the handoff board so "sign me up!" never dead-ends in silence.
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
 * answer → human handoff.
 *
 * AUTOPILOT DOES SOMETHING REAL (AUDIT-2026-10 O8): a deterministic allow-listed answer to
 * an emailed reply is SENT, threaded, through the same transport the handoff queue's "send
 * reply" uses, and the reply is marked handled by the AI-SDR. Everything else gets a handoff
 * with the answer as a suggested reply — a generative answer, HITL mode, a reply with no email
 * to answer (pasted by the operator, a DM), and an autopilot send that failed. It used to
 * return `autoSend: true` to nobody: the reply was stored and nothing else happened.
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
  let autoSendError: string | undefined;
  // Autopilot only auto-sends the deterministic, allow-listed answers — never a generative one.
  if (mode === "autopilot" && deterministic && AUTO_ANSWER_TOPICS.includes(topic)) {
    if (opts.canAutoSend) {
      // The compliance footer `sendReplyToProspect` adds to an automated reply signs it off.
      const sent = await sendReplyToProspect(deps, {
        prospectId: prospect.id,
        body: `Hi ${prospect.identity},\n\n${answer}`,
        inReplyToMessageId: opts.inboundMessageId ?? null,
        automated: true,
      });
      if (sent.sent) {
        const handled = await deps.db.replies.update(reply.id, { handledBy: "ai_sdr" });
        return { reply: handled, classification: reply.classification, action: "ai_sdr", answer, autoSend: true, signupUrl, topic };
      }
      autoSendError = sent.reason ?? "send failed";
    } else {
      autoSendError = "no email to answer (this reply did not arrive by email)";
    }
  }
  // HITL (default), a generative answer, or an autopilot answer that could not be sent →
  // queue it for a human to approve + send.
  const summary = autoSendError && opts.canAutoSend ? `${summarizeReply(raw, topic)} — autopilot could not send its answer: ${autoSendError}` : summarizeReply(raw, topic);
  const handoff = await createHandoff(deps, { prospect, reply, topic, intent: reply.classification, reason: "approval", summary, suggestedReply: answer });
  return { reply, classification: reply.classification, action: "ai_sdr", answer, autoSend: false, ...(autoSendError ? { autoSendError } : {}), handoff, needsHuman: true, signupUrl, topic };
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
      .catch((e) => loggerOf(deps).warn("handoff notification failed", { handoffId: handoff.id, error: e instanceof Error ? e.message : String(e) }));
  }
  return handoff;
}

/** `<id@host>` for a stored id that IS a Message-Id; undefined for a synthesized dedup key
 *  (those look like `from@host:digest` and must never be put in an In-Reply-To header). */
function asMessageId(id: string | null | undefined): string | undefined {
  if (!id || !/^<?[^\s<>]+@[^\s<>:]+>?$/.test(id)) return undefined;
  return id.startsWith("<") ? id : `<${id}>`;
}

/**
 * Actually SEND a reply to a prospect as the merchant (the in-product "send" the Handoffs
 * queue offers, and the transport autopilot answers go through). Resolves the campaign mailbox,
 * threads onto the inbound Reply's Message-Id, and records the sent message. Returns
 * `sent: false` with a reason when it can't send — it never reports a send that did not happen.
 *
 * Runs under the merchant's send lock, refuses a suppressed/bounced contact (a STOP that
 * arrived after the reply was drafted wins), and a mailbox resolver that throws yields a
 * failure — never the mock (AUDIT-2026-10 O3/O4). `automated` marks a reply no person
 * reviewed: it carries the compliance footer and needs the merchant's postal address.
 */
export async function sendReplyToProspect(
  deps: RecruitmentDeps,
  args: { prospectId: string; body: string; inReplyToMessageId?: string | null; subject?: string; automated?: boolean },
): Promise<{ sent: boolean; reason?: string; messageId?: string }> {
  const target = await deps.db.prospects.require(args.prospectId);
  return withMerchantLock(deps, target.merchantId, () => sendReplyLocked(deps, args));
}

async function sendReplyLocked(
  deps: RecruitmentDeps,
  args: { prospectId: string; body: string; inReplyToMessageId?: string | null; subject?: string; automated?: boolean },
): Promise<{ sent: boolean; reason?: string; messageId?: string }> {
  const prospect = await deps.db.prospects.require(args.prospectId);
  if (!prospect.email) return { sent: false, reason: "prospect has no email" };
  if (prospect.state === "suppressed" || prospect.state === "bounced" || (await isSuppressed(deps, prospect.merchantId, prospect.email))) {
    return { sent: false, reason: "this contact has unsubscribed or bounced — not sent" };
  }
  const merchant = await deps.db.merchants.require(prospect.merchantId);
  let body = args.body;
  if (args.automated) {
    const compliance = outreachBlockedReason(merchant);
    if (compliance) return { sent: false, reason: compliance };
    body += `\n\n—\n${merchant.name}\n${merchant.physicalAddress}\nUnsubscribe: reply STOP`;
  }

  // Resolve the mailbox from the prospect's most recent OUTBOUND message's campaign.
  const sentMsgs = (await deps.db.outreachMessages.find((m) => m.prospectId === prospect.id && (m.status === "sent" || m.status === "replied"))).sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""));
  const lastOut = sentMsgs[0];
  const campaign = lastOut ? await deps.db.campaigns.get(lastOut.campaignId) : null;
  const mailboxId = campaign?.mailboxId ?? null;
  const mailbox = mailboxId ? await deps.db.mailboxes.get(mailboxId) : null;
  if (mailbox && (mailbox.status === "error" || mailbox.status === "disconnected")) {
    return { sent: false, reason: `mailbox ${mailbox.status === "error" ? "is auto-paused" : "is disconnected"}` };
  }
  let sender: MailboxSender;
  if (deps.mailboxResolver) {
    try {
      sender = await deps.mailboxResolver(mailboxId);
    } catch (e) {
      sender = unavailableMailboxSender(`mailbox sender could not be resolved: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  } else {
    sender = deps.mailer;
  }

  // Thread onto the creator's inbound message (so it lands in-conversation).
  const inReplyTo = asMessageId(args.inReplyToMessageId);
  const ours = [...sentMsgs].reverse().map((m) => asMessageId(m.providerMessageId)).filter((id): id is string => !!id);
  const references = [...ours, ...(inReplyTo ? [inReplyTo] : [])];
  const subject = args.subject ?? (lastOut ? `Re: ${lastOut.subject.replace(/^(re|fwd):\s*/i, "")}` : `Re: ${merchant.name}`);
  const fromEmail = mailbox?.email ?? "no-reply@example.invalid";
  const messageId = newMessageId(fromEmail);
  let result: SendResult;
  try {
    result = await sender.send({
      fromName: merchant.name,
      fromEmail,
      toEmail: prospect.email,
      subject,
      body,
      messageId,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references.length ? { references } : {}),
    });
  } catch (e) {
    result = { messageId: "", status: "failed", reason: `sender error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200), failure: "unknown" };
  }
  if (result.status !== "sent") {
    if (mailbox && result.status === "failed" && result.failure !== "recipient") {
      await recordSendFailure(deps, mailbox.id, result.reason ?? "transport error", deps.clock.now());
    }
    return { sent: false, reason: result.reason ?? "send failed" };
  }
  if (mailbox) await recordSendSuccess(deps, mailbox.id);

  const now = deps.clock.now().toISOString();
  const stored = result.messageId && result.messageId.includes("@") ? result.messageId : messageId;
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
    providerMessageId: stored,
  });
  return { sent: true, messageId: stored };
}

/** Prospect states that can plausibly be replying to OUR outreach. A prospect we never
 * contacted sending us mail is inbox noise (their newsletter, unrelated business), not a reply. */
const REPLYABLE_STATES = new Set(["queued", "contacted", "in_sequence", "replied"]);

export interface ProcessInboundOptions extends RouteOptions {
  /** Scope prospect matching to ONE merchant (the mailbox's owner). Without it, a reply to
   * merchant A's mailbox could route to merchant B's prospect for the same creator. */
  merchantId?: string;
}

export interface ProcessInboundResult {
  /** True when the mail was matched to a prospect AND routed as a reply. */
  matched: boolean;
  prospectId?: string;
  outcome?: ReplyOutcome;
  ignoredReason?: string;
  /** Set when the mail was a delivery-status notification that was tied to one of our sends. */
  bounce?: { prospectId: string; messageId: string; kind: "hard" | "other" };
}

const bare = (id: string): string => id.trim().replace(/^<|>$/g, "");
const normalizeSubject = (s: string): string => s.replace(/^(\s*(re|fwd?|aw|sv|antw)\s*:\s*)+/i, "").trim().toLowerCase();

/** Message-Ids named by a mail's In-Reply-To / References headers (bracket-less). */
function referencedIds(inbound: Pick<InboundReply, "inReplyTo" | "references">): Set<string> {
  const ids = new Set<string>();
  for (const m of `${inbound.inReplyTo ?? ""} ${inbound.references ?? ""}`.matchAll(/<?([^<>\s,]+@[^<>\s,]+)>?/g)) ids.add(m[1]!);
  return ids;
}

/**
 * Bridge an INBOUND email (from an inbox poll or an inbound-parse webhook) to the reply
 * router: tie it to a prospect and route it. This is what makes replies stop the sequence +
 * drive the two-track handoff automatically — without it the engine keeps emailing people
 * who already answered.
 *
 * Safety rails (all inbound paths go through here):
 *  - a delivery-status notification is a BOUNCE, never a reply (see `processBounce`);
 *  - tenant scoping (opts.merchantId) — never route across merchants;
 *  - Message-Id dedup — provider webhook retries and overlapping reads can't double-route;
 *  - THREAD FIRST: a mail whose In-Reply-To/References names a Message-Id we sent belongs to
 *    that prospect whatever address it came from (an alias reply still stops the sequence).
 *    Only then is the From address tried;
 *  - mail matched by sender alone must come from a prospect we actually contacted and must
 *    not be list/bulk mail (their newsletter is not a reply), and — being uncorrelated — can
 *    never suppress them on wording.
 */
export async function processInboundReply(
  deps: RecruitmentDeps,
  inbound: InboundReply,
  opts: ProcessInboundOptions = {},
): Promise<ProcessInboundResult> {
  // "Seen this Message-Id? no → route it" must be ONE step per merchant: two readers handing
  // over the same message at the same moment (the API's scheduler and the worker, a webhook
  // retry) would otherwise both route it — two handoffs, or two autopilot answers.
  return withKeyLock(deps, `merchant-inbound:${opts.merchantId ?? "*"}`, () => processInboundLocked(deps, inbound, opts));
}

async function processInboundLocked(deps: RecruitmentDeps, inbound: InboundReply, opts: ProcessInboundOptions): Promise<ProcessInboundResult> {
  if (inbound.bounce) return processBounce(deps, inbound, opts);

  // `Name <addr>` → addr: every ESP and most clients send the display form.
  const from = parseAddress(inbound.fromEmail);
  if (!from) return { matched: false };

  // Dedup FIRST (centralized here so every path — IMAP, HMAC webhook, public webhook — gets it).
  // Within the merchant: the same message landing in two merchants' inboxes (a creator
  // answering both in one email) is a reply to each of them, not a duplicate of the other's.
  if (inbound.messageId) {
    for (const seen of await deps.db.replies.find((r) => r.inboundMessageId === inbound.messageId)) {
      const owner = opts.merchantId ? await deps.db.prospects.get(seen.prospectId) : null;
      if (!opts.merchantId || owner?.merchantId === opts.merchantId) return { matched: false, ignoredReason: "duplicate message id" };
    }
  }

  // 1) By thread: does the mail reference a Message-Id WE stamped on a send?
  let prospect: Prospect | null = null;
  let correlated = false;
  const refs = referencedIds(inbound);
  if (refs.size) {
    const ours = (await deps.db.outreachMessages.find((m) => !!m.providerMessageId && refs.has(bare(m.providerMessageId)))).sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? ""));
    for (const m of ours) {
      const p = await deps.db.prospects.get(m.prospectId);
      if (p && (!opts.merchantId || p.merchantId === opts.merchantId)) {
        prospect = p;
        correlated = true;
        break;
      }
    }
  }

  // 2) By the sender's address, scoped to the owning merchant when known.
  //    (Prefer the most recently updated when an address was reused across prospects.)
  if (!prospect) {
    const candidates = await deps.db.prospects.find(
      (p) => (p.email ?? "").toLowerCase() === from && (!opts.merchantId || p.merchantId === opts.merchantId),
    );
    prospect = candidates.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0] ?? null;
    if (!prospect) return { matched: false };
    // A "Re: <subject we sent them>" is a reply even when the client dropped the thread headers.
    const subject = normalizeSubject(inbound.subject ?? "");
    if (subject && /^\s*(re|aw|sv|antw)\s*:/i.test(inbound.subject ?? "")) {
      const sent = await deps.db.outreachMessages.find((m) => m.prospectId === prospect!.id && (m.status === "sent" || m.status === "replied"));
      correlated = sent.some((m) => normalizeSubject(m.subject) === subject);
    }
  }

  if (!correlated && !REPLYABLE_STATES.has(prospect.state)) {
    return { matched: false, ignoredReason: `prospect never contacted (state ${prospect.state}) and mail references none of our messages` };
  }
  if (!correlated && inbound.bulk) {
    return { matched: false, ignoredReason: "list/bulk mail from a prospect's address that references none of our messages — not a reply" };
  }

  const outcome = await routeReply(deps, prospect.id, inbound.body, {
    ...opts,
    inboundMessageId: inbound.messageId || undefined,
    correlated,
    canAutoSend: correlated,
    ...(from !== (prospect.email ?? "").toLowerCase() ? { replyFrom: from } : {}),
  });
  return { matched: true, prospectId: prospect.id, outcome };
}

/**
 * A delivery-status notification arrived in the merchant's inbox (AUDIT-2026-10 O6). Real
 * relays accept a message and bounce it minutes later, so a synchronous rejection is the
 * rare case — without this, the breaker, the auto-pause and bounce suppression never saw most
 * bounces.
 *
 * The report is tied to OUR send by the original Message-Id it quotes (else by a failed
 * recipient we actually emailed, in this merchant), then:
 *  - hard (the recipient's address is permanently bad) → the message becomes `bounced` (so
 *    it counts in the mailbox's and the merchant's bounce rate), the prospect is marked
 *    bounced and suppressed at MERCHANT scope;
 *  - a failure that is not the recipient's fault (policy, quota, sender rejected) → the
 *    prospect is NOT suppressed; the failure is noted on the message and the mailbox is held
 *    back like any other transport failure;
 *  - delayed / delivered → nothing to do.
 * Idempotent: a notification read twice changes nothing the second time.
 */
async function processBounce(deps: RecruitmentDeps, inbound: InboundReply, opts: ProcessInboundOptions): Promise<ProcessInboundResult> {
  const report = inbound.bounce!;
  const ignored = (ignoredReason: string): ProcessInboundResult => ({ matched: false, ignoredReason });
  if (report.kind === "soft") return ignored("delivery delayed (transient) — nothing to do yet");
  if (report.action !== "failed") return ignored("delivery-status notification that is not a failure");

  let message: OutreachMessage | null = null;
  let prospect: Prospect | null = null;
  const ids = new Set(report.originalMessageIds.map(bare));
  if (ids.size) {
    for (const m of await deps.db.outreachMessages.find((x) => !!x.providerMessageId && ids.has(bare(x.providerMessageId)))) {
      const p = await deps.db.prospects.get(m.prospectId);
      if (p && (!opts.merchantId || p.merchantId === opts.merchantId)) {
        message = m;
        prospect = p;
        break;
      }
    }
  }
  if (!prospect) {
    const recipients = new Set(report.recipients.map((r) => r.toLowerCase()));
    const candidates = (await deps.db.prospects.find((p) => !!p.email && recipients.has(p.email.toLowerCase()) && (!opts.merchantId || p.merchantId === opts.merchantId))).sort((a, b) =>
      (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
    for (const p of candidates) {
      // Only someone we actually emailed: the newest transmitted message to them.
      const sent = (await deps.db.outreachMessages.find((m) => m.prospectId === p.id && !!m.sentAt && (m.status === "sent" || m.status === "replied" || m.status === "bounced"))).sort((a, b) =>
        (b.sentAt ?? "").localeCompare(a.sentAt ?? ""),
      )[0];
      if (sent) {
        message = sent;
        prospect = p;
        break;
      }
    }
  }
  if (!prospect || !message) return ignored("delivery-status notification for a message we did not send");

  const now = deps.clock.now();
  const detail = [report.status, report.diagnostic].filter(Boolean).join(" ").slice(0, 300) || "delivery failed";
  const bounce = { prospectId: prospect.id, messageId: message.id, kind: report.kind === "hard" ? ("hard" as const) : ("other" as const) };

  if (report.kind !== "hard") {
    if (message.deliveryError) return { matched: false, ignoredReason: "delivery failure already recorded", bounce };
    await deps.db.outreachMessages.update(message.id, { deliveryError: detail });
    const campaign = await deps.db.campaigns.get(message.campaignId);
    if (campaign?.mailboxId) await recordSendFailure(deps, campaign.mailboxId, `delivery failed after acceptance: ${detail}`, now);
    return { matched: false, ignoredReason: "delivery failed for a reason that is not the recipient's address — prospect not suppressed", bounce };
  }

  if (message.status === "bounced") return { matched: false, ignoredReason: "bounce already recorded", bounce };
  if (prospect.email && !(await isSuppressed(deps, prospect.merchantId, prospect.email))) {
    await suppress(deps, { merchantId: prospect.merchantId, email: prospect.email, reason: "hard bounce", scope: "merchant" });
  }
  if (canTransition(prospect.state, "bounced")) {
    await deps.db.prospects.update(prospect.id, { state: "bounced", suppressionStatus: "bounced", updatedAt: now.toISOString() });
  }
  await deps.db.outreachMessages.update(message.id, { status: "bounced", deliveryError: detail });
  return { matched: false, ignoredReason: "hard bounce recorded — prospect suppressed for this merchant", bounce };
}

/**
 * Read every connected mailbox for new inbound mail and route it (the scheduler's inbound
 * loop; the webhook path is the push equivalent). For each mailbox: pull via
 * `deps.replyPoller` from the mailbox's stored cursor (without mutating flags), route each
 * message through `processInboundReply` with the merchant's own meeting tier, then advance
 * the cursor. Safe to call every scheduler tick.
 *
 * It also WRITES each mailbox's inbound health (AUDIT-2026-10 O5): "ok" when the inbox was
 * read, "error" (with the reason) when the read failed, "unavailable" when the rail has no way
 * to read replies. That is what holds follow-ups on a mailbox we cannot hear from, and what
 * the UI warns on. Failures are isolated per mailbox and per message, and LOGGED.
 */
export async function ingestReplies(
  deps: RecruitmentDeps,
  opts: { signupBaseUrl?: string; merchantId?: string; mailboxId?: string } = {},
): Promise<{ mailboxes: number; polled: number; matched: number; bounced?: number; failed?: number }> {
  if (!deps.replyPoller) return { mailboxes: 0, polled: 0, matched: 0 };
  const log = loggerOf(deps);
  const mailboxes = await deps.db.mailboxes.find(
    (m) =>
      m.status !== "disconnected" &&
      !!m.credentialsRef &&
      (!opts.merchantId || m.merchantId === opts.merchantId) &&
      (!opts.mailboxId || m.id === opts.mailboxId),
  );
  const routeOptsByMerchant = new Map<string, RouteOptions>();
  let polled = 0;
  let matched = 0;
  let bounced = 0;
  let failed = 0;
  let mailboxesPolled = 0;
  for (const listed of mailboxes) {
    // One reader per mailbox at a time, and it reads the row (and its cursor) fresh inside the
    // lock — two processes ticking together must not fetch and route the same mail twice.
    await withKeyLock(deps, `mailbox-inbound:${listed.id}`, async () => {
      const mailbox = await deps.db.mailboxes.get(listed.id);
      if (!mailbox || mailbox.status === "disconnected" || !mailbox.credentialsRef) return;
      const pollStart = deps.clock.now().toISOString();
      let outcome: Awaited<ReturnType<NonNullable<RecruitmentDeps["replyPoller"]>>>;
      try {
        outcome = await deps.replyPoller!(mailbox);
      } catch (e) {
        // Isolate one mailbox's transport failure from the rest — but record it: the mailbox
        // cannot hear replies right now, so its follow-ups are held until a read succeeds.
        failed++;
        const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        log.warn("inbound read failed", { mailboxId: mailbox.id, merchantId: mailbox.merchantId, error });
        await deps.db.mailboxes.update(mailbox.id, { inboundStatus: "error", inboundError: error }).catch(() => {});
        return;
      }
      if (!Array.isArray(outcome) && "unavailable" in outcome) {
        if (mailbox.inboundStatus !== "unavailable" || mailbox.inboundError !== outcome.unavailable) {
          await deps.db.mailboxes.update(mailbox.id, { inboundStatus: "unavailable", inboundError: outcome.unavailable });
        }
        return;
      }
      const replies = Array.isArray(outcome) ? outcome : outcome.replies;
      const cursor = Array.isArray(outcome) ? undefined : outcome.cursor;
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
      let allRouted = true;
      for (const inbound of replies) {
        polled++;
        try {
          // processInboundReply centralizes bounce handling, dedup (by Message-Id), tenant scoping
          // (this mailbox's merchant), and the thread/sender correlation guards.
          const res = await processInboundReply(deps, inbound, { ...routeOpts, merchantId: mailbox.merchantId });
          if (res.matched && res.outcome) matched++;
          if (res.bounce) bounced++;
        } catch (e) {
          allRouted = false;
          failed++;
          log.error("routing an inbound message failed", { mailboxId: mailbox.id, merchantId: mailbox.merchantId, messageId: inbound.messageId, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // The inbox was read. Advance the cursor only when every message of this read was handled —
      // one that failed is read again next time (Message-Id dedup absorbs the rest).
      await deps.db.mailboxes.update(mailbox.id, {
        inboundStatus: "ok",
        inboundError: null,
        ...(allRouted ? { lastPolledAt: pollStart, ...(cursor !== undefined ? { inboundCursor: cursor } : {}) } : {}),
      });
    });
  }
  return { mailboxes: mailboxesPolled, polled, matched, ...(bounced ? { bounced } : {}), ...(failed ? { failed } : {}) };
}

const REPLY_CLASSES: ReadonlySet<string> = new Set(["interested", "question", "not_interested", "out_of_office", "unsubscribe", "unknown"]);

/** Use the real LLM for intent when available; fall back to the keyword classifier. */
async function classify(deps: RecruitmentDeps, raw: string): Promise<Reply["classification"]> {
  const keyword = classifyReply(raw) as Reply["classification"];
  // Deterministic opt-out FIRST — "STOP" / "Stop please" / "unsubscribe me" must unsubscribe
  // no matter what any model says.
  if (keyword === "unsubscribe") return "unsubscribe";
  if (deps.llm.model === "deterministic-llm-v1") return keyword;
  try {
    const out = await deps.llm.complete(
      `Classify the intent of this email reply as exactly one of: interested, question, not_interested, out_of_office, unsubscribe, unknown.\n\nReply:\n"""${raw}"""\n\nReturn JSON: {"classification": "..."}`,
      { json: true, maxTokens: 64 },
    );
    const c = parseJsonObject(out).classification;
    // Only an answer that IS one of the classes is trusted. Anything else the model invents
    // ("spam", "positive", a sentence) used to be stored and silently fell through every branch.
    return typeof c === "string" && REPLY_CLASSES.has(c) ? (c as Reply["classification"]) : keyword;
  } catch {
    return keyword;
  }
}
