import { newId, type Tier } from "@affiliate/core";
import { classifyReply, type InboundReply } from "@affiliate/integrations";
import type { Meeting, Reply } from "@affiliate/db";
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
  | "review";

export interface ReplyOutcome {
  reply: Reply;
  classification: Reply["classification"];
  action: ReplyAction;
  /** Self-serve signup link (long-tail track). */
  signupUrl?: string;
  /** AI-SDR generated answer to a question. */
  answer?: string;
  /** Booked meeting (managed track). */
  meeting?: Meeting;
  bookingUrl?: string;
}

const tierRank: Record<Tier, number> = { A: 3, B: 2, C: 1 };

export interface RouteOptions {
  /** Tier at/above which an interested reply books a meeting (managed track). */
  meetingTier?: Tier;
  /** Base URL for self-serve signup links. */
  signupBaseUrl?: string;
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
    return { reply, classification, action: "meeting_booked", meeting, bookingUrl: bookingUrl ?? undefined };
  }

  // Long-tail self-serve track. For a question, the AI-SDR drafts an answer.
  const signupUrl = `${opts.signupBaseUrl ?? "https://app.vantage.dev/join"}/${prospect.merchantId.slice(-6)}?p=${prospectId.slice(-8)}`;
  if (classification === "question") {
    const answer = await aiSdrAnswer(deps, prospect.identity, raw, signupUrl);
    return { reply, classification, action: "ai_sdr", answer, signupUrl };
  }
  return { reply, classification, action: "self_serve", signupUrl };
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
  const meetingTierByMerchant = new Map<string, Tier>();
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
    if (!meetingTierByMerchant.has(mailbox.merchantId)) {
      const state = await deps.db.automationStates.get(mailbox.merchantId);
      meetingTierByMerchant.set(mailbox.merchantId, (state?.meetingTier as Tier) ?? "A");
    }
    const meetingTier = meetingTierByMerchant.get(mailbox.merchantId)!;
    for (const inbound of replies) {
      polled++;
      if (inbound.messageId) {
        const seen = await deps.db.replies.findOne((r) => r.inboundMessageId === inbound.messageId);
        if (seen) continue;
      }
      const res = await processInboundReply(deps, inbound, { meetingTier, signupBaseUrl: opts.signupBaseUrl });
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

/** AI-SDR: answer a routine question and drive to self-serve signup. */
async function aiSdrAnswer(deps: RecruitmentDeps, name: string, question: string, signupUrl: string): Promise<string> {
  if (deps.llm.model === "deterministic-llm-v1") {
    return `Hi ${name}, great question — happy to help. You can see the program terms and join here: ${signupUrl}`;
  }
  try {
    return await deps.llm.complete(
      `You are an affiliate-program SDR replying to a creator's question. Be concise, warm, and end by inviting them to join at ${signupUrl}.\n\nTheir question: ${question}`,
      { system: "Answer in 2-3 sentences, in the merchant's voice. No AI tells.", maxTokens: 256 },
    );
  } catch {
    return `Thanks for asking! You can review everything and join here: ${signupUrl}`;
  }
}
