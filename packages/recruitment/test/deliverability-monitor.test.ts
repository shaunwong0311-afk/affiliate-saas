import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDatabase, type Database, type Mailbox, type OutreachMessage } from "@affiliate/db";
import { HashingEmbedder, DeterministicLlm, StubEmailFinder, MockMailboxSender, DEFAULT_DISCOVERY_SOURCES } from "@affiliate/integrations";
import { systemClock, newId } from "@affiliate/core";
import { monitorDeliverability, mailboxHealth, pickSendableMailbox, type RecruitmentDeps } from "../src/index.js";

let db: Database;
const NOW = new Date("2026-07-01T12:00:00.000Z");
const clock = { now: () => NOW };

function makeDeps(): RecruitmentDeps {
  return { db, embedder: new HashingEmbedder(), llm: new DeterministicLlm(), emailFinder: new StubEmailFinder(), mailer: new MockMailboxSender(), discoverySources: DEFAULT_DISCOVERY_SOURCES, clock };
}

function mailbox(over: Partial<Mailbox> = {}): Mailbox {
  return { id: newId("mbx"), merchantId: "m1", provider: "smtp", email: "a@lumen.com", status: "connected", dailyCap: 50, warmupStatus: "ready", credentialsRef: "ref", ...over };
}

async function seedSends(mailboxId: string, sent: number, bounced: number) {
  const campaignId = newId("camp");
  await db.campaigns.insert({ id: campaignId, merchantId: "m1", mailboxId, sendingDomainId: null, name: "c", sequence: [], sendWindow: { startHour: 9, endHour: 17, timezone: "UTC" }, dailyCap: 50, status: "active" });
  const msgs: OutreachMessage[] = [];
  for (let i = 0; i < sent; i++) msgs.push({ id: newId("om"), prospectId: newId("p"), campaignId, step: 1, variant: null, subject: "s", body: "b", sentAt: NOW.toISOString(), status: i < bounced ? "bounced" : "sent" });
  for (const m of msgs) await db.outreachMessages.insert(m);
}

beforeEach(() => {
  db = createMemoryDatabase();
});

describe("mailboxHealth", () => {
  it("computes the per-mailbox bounce rate over the window", async () => {
    const mbx = await db.mailboxes.insert(mailbox());
    await seedSends(mbx.id, 40, 4); // 10% bounce
    const h = await mailboxHealth(makeDeps(), mbx, NOW);
    expect(h.sent).toBe(40);
    expect(h.bounced).toBe(4);
    expect(h.bounceRate).toBeCloseTo(0.1);
    expect(h.circuitOpen).toBe(true); // >2% over ≥20 sends
  });

  it("does not trip the breach below the minimum volume", async () => {
    const mbx = await db.mailboxes.insert(mailbox());
    await seedSends(mbx.id, 10, 5); // 50% but only 10 sends
    const h = await mailboxHealth(makeDeps(), mbx, NOW);
    expect(h.circuitOpen).toBe(false);
  });
});

describe("monitorDeliverability", () => {
  it("auto-pauses a mailbox that breaches the bounce ceiling and drops it from rotation", async () => {
    const bad = await db.mailboxes.insert(mailbox({ email: "bad@lumen.com" }));
    const good = await db.mailboxes.insert(mailbox({ email: "good@lumen.com" }));
    await seedSends(bad.id, 50, 5); // 10% bounce → pause
    await seedSends(good.id, 5, 0); // healthy + capacity to spare

    const res = await monitorDeliverability(makeDeps(), "m1", NOW);
    expect(res.paused).toContain(bad.id);
    expect((await db.mailboxes.require(bad.id)).status).toBe("error");
    expect((await db.mailboxes.require(bad.id)).autoPausedReason).toMatch(/bounce/);

    // The paused mailbox is no longer sendable; the healthy one still is.
    const picked = await pickSendableMailbox(makeDeps(), "m1", NOW);
    expect(picked?.id).toBe(good.id);
  });

  it("graduates a warming mailbox to ready after the warmup window; starts the clock if unset", async () => {
    // No warmupStartedAt → first monitor stamps the clock (no graduation yet).
    const fresh = await db.mailboxes.insert(mailbox({ warmupStatus: "warming", warmupStartedAt: null }));
    await monitorDeliverability(makeDeps(), "m1", NOW);
    expect((await db.mailboxes.require(fresh.id)).warmupStartedAt).toBeTruthy();
    expect((await db.mailboxes.require(fresh.id)).warmupStatus).toBe("warming");

    // Warming for >21 days → graduates to ready.
    const old = new Date(NOW.getTime() - 22 * 86_400_000).toISOString();
    const aged = await db.mailboxes.insert(mailbox({ email: "aged@lumen.com", warmupStatus: "warming", warmupStartedAt: old }));
    const res = await monitorDeliverability(makeDeps(), "m1", NOW);
    expect(res.warmed).toContain(aged.id);
    expect((await db.mailboxes.require(aged.id)).warmupStatus).toBe("ready");
  });

  it("does not re-pause an already-paused mailbox", async () => {
    const mbx = await db.mailboxes.insert(mailbox({ status: "error", autoPausedReason: "already" }));
    await seedSends(mbx.id, 50, 10);
    const res = await monitorDeliverability(makeDeps(), "m1", NOW);
    expect(res.paused).not.toContain(mbx.id);
  });
});
