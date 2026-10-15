import { describe, it, expect } from "vitest";
import { GraphReplyIngestion, type GraphHttpClient } from "../src/index.js";

/**
 * AUDIT-2026-10 O5(b) — a mailbox connected through Microsoft OAuth had NO inbound path: the
 * poller returned [] for it, so replies and STOP requests were never seen while follow-ups
 * kept going. This is the Graph inbox reader behind the same reply poller, exercised against
 * an injected HTTP client (no live Graph call has ever been made).
 */

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeGraph(pages: Array<{ status?: number; json: unknown }>): GraphHttpClient & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async get(url, headers) {
      calls.push({ url, headers: headers ?? {} });
      const page = pages[Math.min(calls.length - 1, pages.length - 1)]!;
      return { status: page.status ?? 200, json: page.json };
    },
  };
}

function graphMessage(over: Record<string, unknown> = {}) {
  return {
    id: "AAMkAGI2",
    internetMessageId: "<reply-1@site.com>",
    subject: "Re: Partnering with Lumen Skincare",
    from: { emailAddress: { name: "Trail Geek", address: "Creator@Site.com" } },
    toRecipients: [{ emailAddress: { address: "team@lumen.com" } }],
    receivedDateTime: "2026-07-02T14:05:00Z",
    body: { contentType: "text", content: "Yes, I'm interested!\r\n\r\nOn Wed, Lumen wrote:\r\n> Hi — partner with us?\r\n> Unsubscribe: reply STOP, or https://x/u" },
    uniqueBody: { contentType: "text", content: "Yes, I'm interested!" },
    internetMessageHeaders: [
      { name: "In-Reply-To", value: "<our-first-touch@lumen.com>" },
      { name: "References", value: "<our-first-touch@lumen.com>" },
    ],
    ...over,
  };
}

const since = new Date("2026-07-02T14:00:00.000Z");

describe("GraphReplyIngestion", () => {
  it("lists the Inbox from the cursor, oldest first, read-only, with the bearer token", async () => {
    const http = fakeGraph([{ json: { value: [] } }]);
    await new GraphReplyIngestion({ accessToken: "tok-123", http, since }).poll();

    const { url, headers } = http.calls[0]!;
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
    expect(u.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-07-02T14:00:00.000Z");
    expect(u.searchParams.get("$orderby")).toBe("receivedDateTime asc");
    // The fields that carry threading, the new text and bulk/NDR detection must be asked for.
    for (const field of ["internetMessageId", "uniqueBody", "internetMessageHeaders", "receivedDateTime"]) expect(u.searchParams.get("$select")).toContain(field);
    expect(headers.Authorization).toBe("Bearer tok-123");
    expect(headers.Prefer).toContain('outlook.body-content-type="text"');
    // Only GETs are ever issued — reading must not change the merchant's inbox.
    expect(http.calls).toHaveLength(1);
  });

  it("normalizes a reply: bare lowercased sender, new text only, Message-Id and thread headers", async () => {
    const http = fakeGraph([{ json: { value: [graphMessage()] } }]);
    const [reply] = await new GraphReplyIngestion({ accessToken: "t", http, since }).poll();
    expect(reply).toMatchObject({
      fromEmail: "creator@site.com",
      toEmail: "team@lumen.com",
      subject: "Re: Partnering with Lumen Skincare",
      body: "Yes, I'm interested!",
      messageId: "reply-1@site.com",
      inReplyTo: "<our-first-touch@lumen.com>",
      references: "<our-first-touch@lumen.com>",
      receivedAt: "2026-07-02T14:05:00Z",
    });
    expect(reply!.bounce).toBeUndefined();
    expect(reply!.bulk).toBeUndefined();
  });

  it("falls back to the full body, with quoted history and our footer stripped, when uniqueBody is empty", async () => {
    const http = fakeGraph([{ json: { value: [graphMessage({ uniqueBody: { contentType: "text", content: "" } })] } }]);
    const [reply] = await new GraphReplyIngestion({ accessToken: "t", http, since }).poll();
    expect(reply!.body).toBe("Yes, I'm interested!");
  });

  it("follows @odata.nextLink and advances the cursor to the newest message it saw", async () => {
    const http = fakeGraph([
      { json: { value: [graphMessage({ internetMessageId: "<a@site.com>", receivedDateTime: "2026-07-02T14:05:00Z" })], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=page2" } },
      { json: { value: [graphMessage({ internetMessageId: "<b@site.com>", receivedDateTime: "2026-07-02T14:20:00Z" })] } },
    ]);
    const poller = new GraphReplyIngestion({ accessToken: "t", http, since });
    const replies = await poller.poll();
    expect(replies.map((r) => r.messageId)).toEqual(["a@site.com", "b@site.com"]);
    expect(http.calls[1]!.url).toContain("$skiptoken=page2");
    expect(poller.nextCursor).toBe("graph:2026-07-02T14:20:00.000Z");
  });

  it("resumes from the stored cursor on the next poll", async () => {
    const http = fakeGraph([{ json: { value: [] } }]);
    const poller = new GraphReplyIngestion({ accessToken: "t", http, since, cursor: "graph:2026-07-02T14:20:00.000Z" });
    await poller.poll();
    expect(new URL(http.calls[0]!.url).searchParams.get("$filter")).toBe("receivedDateTime ge 2026-07-02T14:20:00.000Z");
    expect(poller.nextCursor).toBe("graph:2026-07-02T14:20:00.000Z"); // nothing new → the cursor holds
  });

  it("recognizes an Exchange NDR as a bounce, and a newsletter as bulk", async () => {
    const ndr = graphMessage({
      internetMessageId: "<ndr-1@lumen.com>",
      subject: "Undeliverable: Partnering with Lumen Skincare",
      from: { emailAddress: { address: "postmaster@lumen.com" } },
      body: { contentType: "text", content: "Your message to gone@site.com couldn't be delivered.\nRemote Server returned '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup'" },
      uniqueBody: undefined,
      internetMessageHeaders: [
        { name: "X-MS-Exchange-Message-Is-Ndr", value: "" },
        { name: "Content-Type", value: "multipart/report; report-type=delivery-status" },
        { name: "In-Reply-To", value: "<our-first-touch@lumen.com>" },
      ],
    });
    const newsletter = graphMessage({
      internetMessageId: "<news-1@site.com>",
      subject: "This week on the blog",
      internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<https://site.com/u>" }, { name: "List-Id", value: "<weekly.site.com>" }],
    });
    const [bounce, bulk] = await new GraphReplyIngestion({ accessToken: "t", http: fakeGraph([{ json: { value: [ndr, newsletter] } }]), since }).poll();
    expect(bounce!.bounce).toMatchObject({ kind: "hard", status: "5.1.10" });
    expect(bounce!.bounce!.recipients).toContain("gone@site.com");
    expect(bounce!.bounce!.originalMessageIds).toContain("our-first-touch@lumen.com");
    expect(bulk!.bulk).toBe(true);
  });

  it("throws on a refused or failed read, so the mailbox is recorded as unable to hear replies", async () => {
    await expect(new GraphReplyIngestion({ accessToken: "expired", http: fakeGraph([{ status: 401, json: { error: { code: "InvalidAuthenticationToken" } } }]), since }).poll()).rejects.toThrow(/reconnect/);
    await expect(new GraphReplyIngestion({ accessToken: "t", http: fakeGraph([{ status: 403, json: { error: { code: "ErrorAccessDenied" } } }]), since }).poll()).rejects.toThrow(/Mail\.Read/);
    await expect(new GraphReplyIngestion({ accessToken: "t", http: fakeGraph([{ status: 503, json: null }]), since }).poll()).rejects.toThrow(/503/);
  });

  it("synthesizes a stable dedup key when Graph gives no internetMessageId", async () => {
    const msg = graphMessage({ internetMessageId: undefined });
    const poll = async () => (await new GraphReplyIngestion({ accessToken: "t", http: fakeGraph([{ json: { value: [msg] } }]), since }).poll())[0]!.messageId;
    expect(await poll()).toBe(await poll());
    expect(await poll()).toContain("creator@site.com");
  });
});
