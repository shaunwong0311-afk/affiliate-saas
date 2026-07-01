import { describe, it, expect } from "vitest";
import { ImapReplyIngestion, type ImapSession, type ImapMessage } from "../src/index.js";

function fakeSession(messages: ImapMessage[], calls: { since: Date | null; closed: boolean }): (cfg: unknown) => Promise<ImapSession> {
  return async () => ({
    async fetchSince(since) {
      calls.since = since;
      return messages;
    },
    async close() {
      calls.closed = true;
    },
  });
}

const msg = (over: Partial<ImapMessage> = {}): ImapMessage => ({
  uid: 1,
  from: "creator@site.com",
  to: "brand@merchant.com",
  subject: "re: partnership",
  text: "Yes I'm interested!\n\nOn Mon, brand wrote:\n> our original email\n",
  messageId: "abc-123",
  receivedAt: "2026-06-30T10:00:00.000Z",
  ...over,
});

describe("ImapReplyIngestion", () => {
  it("normalizes fetched messages to InboundReply and strips quoted history", async () => {
    const calls = { since: null as Date | null, closed: false };
    const since = new Date("2026-06-29T00:00:00.000Z");
    const poller = new ImapReplyIngestion({ config: { host: "imap.host", port: 993, user: "u", pass: "p" }, since, factory: fakeSession([msg()], calls) });
    const replies = await poller.poll();

    expect(replies).toHaveLength(1);
    expect(replies[0].fromEmail).toBe("creator@site.com");
    expect(replies[0].messageId).toBe("abc-123");
    expect(replies[0].body).toBe("Yes I'm interested!"); // quoted reply removed
    expect(calls.since).toBe(since); // cursor threaded through to the session
    expect(calls.closed).toBe(true); // session always closed
  });

  it("synthesizes a stable messageId when the provider omits one (dedup still works)", async () => {
    const calls = { since: null as Date | null, closed: false };
    const poller = new ImapReplyIngestion({ config: { host: "h", port: 993, user: "u", pass: "p" }, factory: fakeSession([msg({ messageId: "" })], calls) });
    const [reply] = await poller.poll();
    expect(reply.messageId).toContain("creator@site.com");
  });

  it("closes the session even when the fetch throws", async () => {
    const calls = { since: null as Date | null, closed: false };
    const factory = async (): Promise<ImapSession> => ({
      async fetchSince() {
        throw new Error("connection reset");
      },
      async close() {
        calls.closed = true;
      },
    });
    const poller = new ImapReplyIngestion({ config: { host: "h", port: 993, user: "u", pass: "p" }, factory });
    await expect(poller.poll()).rejects.toThrow(/connection reset/);
    expect(calls.closed).toBe(true);
  });
});
