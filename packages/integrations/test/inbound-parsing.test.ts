import { describe, it, expect } from "vitest";
import { classifyReply, parseAddress, parseInboundWebhook, ImapReplyIngestion, type ImapMessage, type ImapSession } from "../src/index.js";

/**
 * AUDIT-2026-10 O7 — `Name <addr>` never matched a prospect; a webhook payload without an id
 * was deduplicated on from+subject (so a second reply was dropped); the word "unsubscribe"
 * anywhere meant suppression (a prospect's own newsletter suppressed them); "STOP please" was
 * `unknown`.
 * AUDIT-2026-10 O15 — the IMAP poll re-read the whole day's inbox on every tick.
 */

describe("parseAddress", () => {
  it.each([
    ["Jane Doe <Jane@Site.com>", "jane@site.com"],
    ['"Doe, Jane" <jane@site.com>', "jane@site.com"],
    ["jane@site.com", "jane@site.com"],
    ["  <jane@site.com>  ", "jane@site.com"],
    ["jane@site.com (Jane Doe)", "jane@site.com"],
    ["Jane <jane@site.com>, Other <other@site.com>", "jane@site.com"],
    ["not an address", ""],
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(parseAddress(input)).toBe(expected);
  });
});

describe("parseInboundWebhook", () => {
  it("reduces `Name <addr>` in From and To to the bare address", () => {
    const inbound = parseInboundWebhook({ from: "Trail Geek <Creator@Site.com>", to: '"Lumen Team" <team@lumen.com>', subject: "Re: hi", text: "Sounds good" });
    expect(inbound).toMatchObject({ fromEmail: "creator@site.com", toEmail: "team@lumen.com" });
  });

  it("returns null when there is no sender address at all", () => {
    expect(parseInboundWebhook({ from: "Undisclosed sender", text: "hi" })).toBeNull();
  });

  it("dedup key without a Message-Id: a retry collapses, a different reply does not", () => {
    const first = { from: "creator@site.com", to: "team@lumen.com", subject: "Re: Partnering with Lumen", text: "What's the commission?" };
    const retry = { ...first };
    const second = { ...first, text: "Also — how long is the cookie window?" };
    const a = parseInboundWebhook(first)!.messageId;
    expect(parseInboundWebhook(retry)!.messageId).toBe(a); // provider retry → same key
    // Same sender, same subject, DIFFERENT message: it used to share the key and be dropped.
    expect(parseInboundWebhook(second)!.messageId).not.toBe(a);
  });

  it("uses the provider's Message-Id when there is one, from the payload or its headers", () => {
    expect(parseInboundWebhook({ from: "a@b.co", text: "x", "Message-Id": "<m-1@b.co>" })!.messageId).toBe("m-1@b.co");
    const viaHeaders = parseInboundWebhook({ from: "a@b.co", text: "x", headers: "Message-ID: <m-2@b.co>\r\nIn-Reply-To: <ours@lumen.com>\r\nReferences: <ours@lumen.com>" })!;
    expect(viaHeaders.messageId).toBe("m-2@b.co");
    expect(viaHeaders.inReplyTo).toBe("<ours@lumen.com>");
  });
});

describe("classifyReply — an opt-out REQUEST, not the word", () => {
  it.each([
    "STOP",
    "Stop.",
    "STOP please",
    "stop please!!",
    "Please stop",
    "unsubscribe",
    "Unsubscribe me, thanks",
    "Please unsubscribe me, not interested.",
    "Hi,\n\nSTOP\n\nThanks",
    "Remove me from your list",
    "please take me off this list",
    "Stop emailing me.",
    "Do not contact me again",
    "I'd like to opt out",
    "Not for me — please stop.",
    "No more emails please",
    "Thanks but please stop emailing this address.",
    "Please unsubscribe from this list",
  ])("unsubscribe: %j", (text) => {
    expect(classifyReply(text)).toBe("unsubscribe");
  });

  it.each([
    // Newsletter boilerplate — the prospect's OWN mailing list landing in the merchant's inbox.
    "New on the blog: 5 trail shoes for 2026.\n\nUnsubscribe | View in browser",
    "Thanks for reading!\nTo unsubscribe from this list, click here.",
    "If you no longer wish to receive these emails, please unsubscribe here.",
    "You can unsubscribe at any time using the link below.",
    "You can opt out anytime from your account settings.",
    // Ordinary sentences that merely contain a trigger word.
    "Stop by our booth at the expo next week!",
    "I couldn't stop reading your product page — tell me more.",
    "How do affiliates unsubscribe their audience from promo emails?",
    // Warm replies that merely LOOK like an opt-out — suppressing these would lose a lead.
    "Please stop me if this isn't relevant, but do you pay recurring commission?",
    "This could get us off to a great start — when can we talk?",
    "Don't message me on Instagram, email is better. I'm interested!",
    "Can you remove me from the cc and loop in my manager instead? She handles partnerships.",
    "Don't email me at this address — use partnerships@site.com, I'd love the details.",
    "Please email me more about the commission structure.",
  ])("NOT unsubscribe: %j", (text) => {
    expect(classifyReply(text)).not.toBe("unsubscribe");
  });

  it("still classifies the rest as before", () => {
    expect(classifyReply("Sounds good, tell me more")).toBe("interested");
    expect(classifyReply("Not interested, no thanks")).toBe("not_interested");
    expect(classifyReply("I'm out of office until Monday")).toBe("out_of_office");
    expect(classifyReply("Do you ship to Canada?")).toBe("question");
  });
});

describe("ImapReplyIngestion resumes by UID instead of re-reading the day", () => {
  const msg: ImapMessage = { uid: 41, from: "creator@site.com", to: "team@lumen.com", subject: "Re: hi", text: "Yes!", messageId: "m-41", receivedAt: "2026-07-02T15:00:00.000Z" };

  function session(seen: { after?: unknown }, position: { uidValidity: string; lastUid: number } | null, messages: ImapMessage[] = [msg]): () => Promise<ImapSession> {
    return async () => ({
      async fetchSince(_since, after) {
        seen.after = after;
        return messages;
      },
      position: () => position,
      async close() {},
    });
  }

  it("hands the stored UID position to the session and exposes the new one", async () => {
    const seen: { after?: unknown } = {};
    const poller = new ImapReplyIngestion({ config: { host: "h", port: 993, user: "u", pass: "p" }, cursor: "imap:1700000000:40", factory: session(seen, { uidValidity: "1700000000", lastUid: 41 }) });
    await poller.poll();
    expect(seen.after).toEqual({ uidValidity: "1700000000", lastUid: 40 }); // fetch only UIDs above 40
    expect(poller.nextCursor).toBe("imap:1700000000:41");
  });

  it("starts without a position on the first poll, then has one to store", async () => {
    const seen: { after?: unknown } = { after: "unset" };
    const poller = new ImapReplyIngestion({ config: { host: "h", port: 993, user: "u", pass: "p" }, factory: session(seen, { uidValidity: "1700000000", lastUid: 41 }) });
    await poller.poll();
    expect(seen.after).toBeNull();
    expect(poller.nextCursor).toBe("imap:1700000000:41");
  });

  it("ignores a cursor it does not understand rather than passing garbage on", async () => {
    const seen: { after?: unknown } = { after: "unset" };
    await new ImapReplyIngestion({ config: { host: "h", port: 993, user: "u", pass: "p" }, cursor: "graph:2026-07-02T14:20:00.000Z", factory: session(seen, null) }).poll();
    expect(seen.after).toBeNull();
  });

  it("keeps the previous cursor when the session reports no position", async () => {
    const poller = new ImapReplyIngestion({ config: { host: "h", port: 993, user: "u", pass: "p" }, cursor: "imap:1700000000:40", factory: session({}, null) });
    await poller.poll();
    expect(poller.nextCursor).toBe("imap:1700000000:40");
  });
});
