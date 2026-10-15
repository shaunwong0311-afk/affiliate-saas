import { describe, it, expect } from "vitest";
import type { Database } from "@affiliate/db";
import type { DiscoverySource, LlmClient } from "@affiliate/integrations";
import {
  advanceSequences,
  autonomousCycle,
  capacityAvailable,
  handleReply,
  hourInTimeZone,
  isValidTimeZone,
  isWithinSendWindow,
  launchCampaign,
  nextSourcingAt,
  outreachBlockedReason,
  personalizeOutreach,
  previewOutreach,
  queueFirstTouch,
  send,
  sentTodayForMailbox,
  shouldDeferForLocalTime,
  setAutomationState,
  getAutomationState,
  tickScheduler,
} from "../src/index.js";
import { DAY, FakeSender, HOUR, MINUTE, NOW, campaignRow, makeDeps, merchantRow, movableClock, prospectRow, recordingLogger, seededDb, sentMessage } from "./helpers/outreach.js";

const SPAMMY = { subject: "FREE MONEY!!!", body: "Get free money now, $$$ guaranteed income — act now!!!" };
const CLEAN = { subject: "Partnering with {{merchant}}", body: "Hi {{name}} — I came across your reviews and think you would be a strong fit for our partner program. Open to hearing the details?" };

async function running(deps: Parameters<typeof setAutomationState>[0], patch: Parameters<typeof setAutomationState>[2] = {}) {
  await setAutomationState(deps, "m1", { status: "running", autoSendMinScore: 0, hitlTier: "A", ...patch });
}

/**
 * AUDIT-2026-10 O11 — a content-gate block never released: after the copy was fixed, the
 * blocked prospects were not retried.
 */
describe("O11 — a content-gate block is released when the copy is fixed", () => {
  it("first touch: held while the copy is unchanged, sent — as the same row — once it is edited", async () => {
    const db = await seededDb({ campaign: { sequence: [{ step: 1, delayDays: 0, kind: "initial", ...SPAMMY }] } });
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com" }));
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });
    await running(deps);

    await autonomousCycle(deps, "m1");
    const blocked = (await db.outreachMessages.find((m) => m.prospectId === "p1"))[0]!;
    expect(blocked.status).toBe("failed");
    expect(blocked.blockedReason).toMatch(/^content gate/);
    expect((await db.prospects.require("p1")).state).toBe("scored");

    await autonomousCycle(deps, "m1"); // nothing changed → still held, no second row, no send
    expect(await db.outreachMessages.count((m) => m.prospectId === "p1")).toBe(1);
    expect(sender.attempts).toHaveLength(0);

    // The operator fixes the copy.
    await db.campaigns.update("c1", { sequence: [{ step: 1, delayDays: 0, kind: "initial", ...CLEAN }] });
    const summary = await autonomousCycle(deps, "m1");

    expect(summary.autoSent).toBe(1);
    const released = (await db.outreachMessages.find((m) => m.prospectId === "p1"))[0]!;
    expect(released.id).toBe(blocked.id); // re-rendered in place
    expect(released.status).toBe("sent");
    expect(released.subject).toBe("Partnering with Lumen Skincare");
    expect(await db.outreachMessages.count((m) => m.prospectId === "p1")).toBe(1);
    expect((await db.prospects.require("p1")).state).toBe("contacted");
  });

  it("follow-up: the same — fix the step and the blocked follow-up goes out", async () => {
    const steps = (followUp: { subject: string; body: string }) => [
      { step: 1, delayDays: 0, kind: "initial" as const, ...CLEAN },
      { step: 2, delayDays: 3, kind: "follow_up" as const, ...followUp },
    ];
    const db = await seededDb({ campaign: { sequence: steps(SPAMMY) } });
    const p = await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com", state: "contacted" }));
    await db.outreachMessages.insert(sentMessage({ prospectId: p.id, sentAt: new Date(NOW.getTime() - 4 * DAY).toISOString(), providerMessageId: undefined }));
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });

    expect((await advanceSequences(deps, "m1", await db.campaigns.require("c1"), NOW)).emailsSent).toBe(0);
    expect((await advanceSequences(deps, "m1", await db.campaigns.require("c1"), NOW)).emailsSent).toBe(0);
    expect(await db.outreachMessages.count((m) => m.step === 2)).toBe(1);
    expect(sender.attempts).toHaveLength(0);

    await db.campaigns.update("c1", { sequence: steps({ subject: "Following up", body: "Circling back on the partner program, {{name}} — happy to send over the details whenever it suits you this week." }) });
    expect((await advanceSequences(deps, "m1", await db.campaigns.require("c1"), NOW)).emailsSent).toBe(1);
    expect(await db.outreachMessages.count((m) => m.step === 2)).toBe(1);
    expect((await db.outreachMessages.find((m) => m.step === 2))[0]!.status).toBe("sent");
  });
});

/**
 * AUDIT-2026-10 O12 — the campaign timezone was stored and ignored (a 9–17 Los Angeles window
 * sent at 03:00 local), and recipient local-time gating existed only in manual launch.
 */
describe("O12 — the send window is measured in the campaign's time zone", () => {
  const la = campaignRow({ sendWindow: { startHour: 9, endHour: 17, timezone: "America/Los_Angeles" } });

  it("09–17 Los Angeles is 09–17 in Los Angeles, summer and winter", () => {
    expect(isWithinSendWindow(la, new Date("2026-07-02T10:00:00Z"))).toBe(false); // 03:00 PDT — it used to send
    expect(isWithinSendWindow(la, new Date("2026-07-02T15:59:00Z"))).toBe(false); // 08:59 PDT
    expect(isWithinSendWindow(la, new Date("2026-07-02T16:00:00Z"))).toBe(true); // 09:00 PDT
    expect(isWithinSendWindow(la, new Date("2026-07-02T23:59:00Z"))).toBe(true); // 16:59 PDT
    expect(isWithinSendWindow(la, new Date("2026-07-03T00:00:00Z"))).toBe(false); // 17:00 PDT
    // Standard time: the same wall-clock window, one UTC hour later.
    expect(isWithinSendWindow(la, new Date("2026-01-15T16:30:00Z"))).toBe(false); // 08:30 PST
    expect(isWithinSendWindow(la, new Date("2026-01-15T17:00:00Z"))).toBe(true); // 09:00 PST
  });

  it("reads the hour in a zone, and an unknown zone as UTC rather than throwing", () => {
    expect(hourInTimeZone(new Date("2026-07-02T23:30:00Z"), "Asia/Singapore")).toBe(7);
    expect(hourInTimeZone(new Date("2026-07-02T00:30:00Z"), "America/New_York")).toBe(20);
    expect(hourInTimeZone(new Date("2026-07-02T13:00:00Z"), "Mars/Olympus")).toBe(13);
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    // UTC campaigns (every existing fixture) behave exactly as before, incl. the all-day window.
    expect(isWithinSendWindow(campaignRow({ sendWindow: { startHour: 0, endHour: 24, timezone: "UTC" } }), new Date("2026-07-02T23:59:00Z"))).toBe(true);
    expect(isWithinSendWindow(campaignRow({ sendWindow: { startHour: 22, endHour: 6, timezone: "UTC" } }), new Date("2026-07-02T03:00:00Z"))).toBe(true); // wraps midnight
  });

  it("a launch at 03:00 Los Angeles time is refused by a 9–17 Los Angeles window", async () => {
    const db = await seededDb({ campaign: { sendWindow: { startHour: 9, endHour: 17, timezone: "America/Los_Angeles" } } });
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com" }));
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender, clock: { now: () => new Date("2026-07-02T10:00:00Z") } });
    const res = await launchCampaign(deps, "c1");
    expect(res.blockedReason).toMatch(/send window/);
    expect(sender.attempts).toHaveLength(0);
    expect(await capacityAvailable(deps, "m1", await db.campaigns.require("c1"), new Date("2026-07-02T10:00:00Z"))).toBe(false);
  });

  it("the autonomous cycle applies the recipient-local send-time gate too", async () => {
    const db = await seededDb();
    // 15:00 UTC Thursday: 09:00 in the US (fine), midnight in Japan (not), unknown geo (never held).
    await db.prospects.insert(prospectRow({ id: "us", email: "a@us-site.com", country: "US", score: 90 }));
    await db.prospects.insert(prospectRow({ id: "jp", email: "b@jp-site.com", country: "JP", score: 80 }));
    await db.prospects.insert(prospectRow({ id: "unknown", email: "c@somewhere.com", country: null, score: 70 }));
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });
    await running(deps);

    const summary = await autonomousCycle(deps, "m1");

    expect(sender.sent.map((e) => e.toEmail).sort()).toEqual(["a@us-site.com", "c@somewhere.com"]);
    expect(summary.deferredLocalTime).toBe(1);
    expect((await db.prospects.require("jp")).state).toBe("scored"); // waits for a better hour
  });

  it("does not hold a recipient forever when their working hours never fall inside the campaign's window", async () => {
    // A Singapore-hours campaign (09–17 SGT = 01–09 UTC) writing to a US creator, whose good
    // local hours are 14–23 UTC: the two never overlap, so waiting would mean never sending.
    const db = await seededDb({ campaign: { sendWindow: { startHour: 9, endHour: 17, timezone: "Asia/Singapore" } } });
    await db.prospects.insert(prospectRow({ id: "us", email: "a@us-site.com", country: "US" }));
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender, clock: { now: () => new Date("2026-07-02T03:00:00Z") } }); // 11:00 SGT, 21:00 the day before in the US
    await running(deps);

    const summary = await autonomousCycle(deps, "m1");

    expect(summary.autoSent).toBe(1); // sent in the campaign's window
    expect(summary.deferredLocalTime).toBe(0);
    // Whereas a recipient whose mornings DO fall in that window is held for them:
    // (17:30 in Japan now; tomorrow 10:00 there is 09:00 in Singapore — inside the window.)
    const sgWindow = campaignRow({ sendWindow: { startHour: 9, endHour: 17, timezone: "Asia/Singapore" } });
    expect(shouldDeferForLocalTime("JP", new Date("2026-07-02T08:30:00Z"), (at) => isWithinSendWindow(sgWindow, at))).toBe(true);
    expect(shouldDeferForLocalTime(null, new Date("2026-07-02T03:00:00Z"), () => true)).toBe(false); // unknown geo never holds
    expect(shouldDeferForLocalTime("US", new Date("2026-07-02T15:00:00Z"), () => true)).toBe(false); // already a good time
  });

  it("the daily cap is a rolling 24 hours, so a window across UTC midnight cannot spend it twice", async () => {
    const db = await seededDb({ mailbox: { dailyCap: 5 } });
    const deps = makeDeps(db);
    // Five sends late on the UTC day…
    for (let i = 0; i < 5; i++) await db.outreachMessages.insert(sentMessage({ prospectId: `p${i}`, sentAt: "2026-07-02T23:50:00.000Z" }));
    // …and twenty minutes later it is a new UTC day, but not a new day's allowance.
    const after = new Date("2026-07-03T00:10:00.000Z");
    expect(await sentTodayForMailbox(deps, "mbx1", after)).toBe(5);
    expect(await capacityAvailable(deps, "m1", await db.campaigns.require("c1"), after)).toBe(false);
    expect(await capacityAvailable(deps, "m1", await db.campaigns.require("c1"), new Date("2026-07-03T23:51:00.000Z"))).toBe(true);
  });
});

/**
 * AUDIT-2026-10 O13 — the postal address was appended only if set and nothing blocked sending
 * without one.
 */
describe("O13 — no postal address, no outreach (and the operator is told why)", () => {
  async function noAddress(): Promise<{ db: Database; sender: FakeSender }> {
    const db = await seededDb({ merchant: { physicalAddress: null } });
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com" }));
    return { db, sender: new FakeSender() };
  }

  it("send() blocks the message with a visible compliance reason and transmits nothing", async () => {
    const { db, sender } = await noAddress();
    const deps = makeDeps(db, { mailer: sender });
    const message = (await queueFirstTouch(deps, "p1", await db.campaigns.require("c1")))!;
    const out = await send(deps, message.id);
    expect(out.status).toBe("failed");
    expect(out.blockedReason).toMatch(/postal address/);
    expect(sender.attempts).toHaveLength(0);
    expect((await db.prospects.require("p1")).state).toBe("scored"); // not burned, not stranded
  });

  it("a launch says so up front instead of queueing mail that cannot go", async () => {
    const { db, sender } = await noAddress();
    const res = await launchCampaign(makeDeps(db, { mailer: sender }), "c1");
    expect(res).toMatchObject({ queued: 0, sent: 0 });
    expect(res.blockedReason).toMatch(/postal address/);
    expect(await db.outreachMessages.count(() => true)).toBe(0);
  });

  it("the cycle reports it, sends nothing, and the preview warns before launch", async () => {
    const { db, sender } = await noAddress();
    const deps = makeDeps(db, { mailer: sender });
    await running(deps);
    const summary = await autonomousCycle(deps, "m1");
    expect(summary.autoSent).toBe(0);
    expect(summary.sendBlockedReason).toMatch(/postal address/);
    expect(sender.attempts).toHaveLength(0);
    expect((await previewOutreach(deps, "p1", await db.campaigns.require("c1")))!.blockedReason).toMatch(/postal address/);
    expect(outreachBlockedReason(merchantRow({ physicalAddress: "   " }))).toMatch(/postal address/); // blank is not an address
    expect(outreachBlockedReason(merchantRow())).toBeNull();
  });

  it("with an address, every outreach email carries it and the opt-out", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com" }));
    const sender = new FakeSender();
    const deps = makeDeps(db, { mailer: sender });
    await send(deps, (await queueFirstTouch(deps, "p1", await db.campaigns.require("c1")))!.id);
    expect(sender.sent[0]!.body).toContain("1 Market St, San Francisco, CA");
    expect(sender.sent[0]!.body).toMatch(/Unsubscribe: reply STOP, or https?:\/\//);
    expect(sender.sent[0]!.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

/**
 * AUDIT-2026-10 O14 — there was no sourcing cadence: every tick (default 60 s) re-ran the full
 * query set, and `lastCycleAt` was written and never read.
 */
describe("O14 — sourcing runs on its own interval; sends and replies run every tick", () => {
  function countingSource(): DiscoverySource & { calls: number } {
    return {
      sourceType: "counting",
      calls: 0,
      async discover() {
        this.calls++;
        return [];
      },
    };
  }

  it("a second cycle a minute later does not source again — but still sends", async () => {
    const db = await seededDb();
    const source = countingSource();
    const sender = new FakeSender();
    const clock = movableClock();
    const deps = makeDeps(db, { mailer: sender, clock, discoverySources: [source] });
    await running(deps);

    const first = await autonomousCycle(deps, "m1");
    expect(source.calls).toBe(1);
    expect(first.sourcingRan).toBe(true);
    expect(first.nextSourcingAt).toBe(new Date(NOW.getTime() + 24 * HOUR).toISOString());

    clock.advance(MINUTE);
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com" })); // something to send
    const second = await autonomousCycle(deps, "m1");

    expect(source.calls).toBe(1); // not re-run
    expect(second.sourcingRan).toBe(false);
    expect(second.autoSent).toBe(1); // sending is not on the sourcing clock
    expect((await getAutomationState(deps, "m1")).lastSourcedAt).toBe(NOW.toISOString());
  });

  it("sources again once the interval has elapsed, and honors the merchant's own interval", async () => {
    const db = await seededDb();
    const source = countingSource();
    const clock = movableClock();
    const deps = makeDeps(db, { clock, discoverySources: [source] });
    await running(deps);

    await autonomousCycle(deps, "m1");
    clock.advance(23 * HOUR);
    await autonomousCycle(deps, "m1");
    expect(source.calls).toBe(1);
    clock.advance(HOUR + MINUTE);
    await autonomousCycle(deps, "m1");
    expect(source.calls).toBe(2);

    await setAutomationState(deps, "m1", { sourcingIntervalHours: 2 });
    clock.advance(HOUR);
    await autonomousCycle(deps, "m1");
    expect(source.calls).toBe(2);
    clock.advance(HOUR + MINUTE);
    await autonomousCycle(deps, "m1");
    expect(source.calls).toBe(3);
  });

  it("sixty scheduler ticks are one sourcing run; the operator can still force one", async () => {
    const db = await seededDb();
    const source = countingSource();
    const clock = movableClock();
    const deps = makeDeps(db, { clock, discoverySources: [source] });
    await running(deps);

    for (let i = 0; i < 60; i++) {
      await tickScheduler(deps);
      clock.advance(MINUTE);
    }
    expect(source.calls).toBe(1); // it used to be 60

    const forced = await autonomousCycle(deps, "m1", { forceSourcing: true });
    expect(source.calls).toBe(2);
    expect(forced.sourcingRan).toBe(true);
  });

  it("a sourcing run that throws is not retried on every tick", async () => {
    const db = await seededDb();
    let calls = 0;
    const clock = movableClock();
    const deps = makeDeps(db, { clock });
    await running(deps);
    await db.merchants.delete("m1"); // runSourcing will now throw
    for (let i = 0; i < 5; i++) {
      await autonomousCycle(deps, "m1").catch(() => calls++);
      clock.advance(MINUTE);
    }
    expect(calls).toBe(5); // each cycle failed…
    expect(nextSourcingAt(await getAutomationState(deps, "m1"))!.getTime()).toBe(NOW.getTime() + 24 * HOUR); // …but sourcing was attempted once
  });

  it("a sourcing failure is reported — and the cycle still sends", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com" }));
    const sender = new FakeSender();
    const logger = recordingLogger();
    const source: DiscoverySource = {
      sourceType: "custom",
      async discover() {
        return [{ identity: "New Creator", siteUrl: "https://newcreator.example", channelUrl: null, sourceType: "custom", evidenceUrl: null, evidenceSummary: "a review", outboundLinks: [], synthetic: true }];
      },
    };
    const brokenEmbedder = { model: "broken", async embed(): Promise<number[]> { throw new Error("embedding provider down"); }, async similarity(): Promise<number> { throw new Error("embedding provider down"); } };
    const deps = makeDeps(db, { mailer: sender, logger, discoverySources: [source], embedder: brokenEmbedder });
    await running(deps);

    const summary = await autonomousCycle(deps, "m1"); // does not throw

    expect(summary.sourcingError).toMatch(/embedding provider down/);
    expect(summary.autoSent).toBe(1); // the prospect that was ready was emailed anyway
    expect(sender.sent.map((e) => e.toEmail)).toEqual(["creator@site.com"]);
    expect(logger.entries.some((e) => e.level === "error" && /sourcing failed/.test(e.message))).toBe(true);
    expect((await getAutomationState(deps, "m1")).lastError).toMatch(/sourcing failed/);
  });

  it("defaults to a daily interval, stored on the automation state", async () => {
    const deps = makeDeps(await seededDb());
    const state = await getAutomationState(deps, "m1");
    expect(state.sourcingIntervalHours).toBe(24);
    expect(nextSourcingAt(state)).toBeNull(); // never sourced → due now
  });
});

/**
 * AUDIT-2026-10 O15 — LLM follow-ups ignored the step copy, and the LLM's class was not checked
 * against the enum.
 */
describe("O15 — LLM follow-ups use the step copy; the LLM's class is validated", () => {
  const capturing = (answer: string) => {
    const prompts: Array<{ prompt: string; system?: string }> = [];
    const llm: LlmClient = { model: "fake-llm", async complete(prompt, opts) { prompts.push({ prompt, system: opts?.system }); return answer; } };
    return { llm, prompts };
  };

  it("a follow-up prompt carries the merchant's copy for THAT step and says it is a follow-up", async () => {
    const db = await seededDb({ merchant: { personalizationPlan: "llm" } });
    const { llm, prompts } = capturing('{"subject":"Quick nudge","body":"Circling back on the Lumen partner program — the spring bundle offer I mentioned closes Friday. Want me to send the details over?"}');
    const deps = makeDeps(db, { llm });
    const step = { step: 2, delayDays: 3, kind: "follow_up" as const, subject: "Following up", body: "Circling back, {{name}} — our spring bundle offer for partners closes Friday." };
    const merchant = merchantRow({ personalizationPlan: "llm" });

    const out = await personalizeOutreach(deps, { merchant, prospect: prospectRow({ identity: "Trail Geek" }), step, tokens: { name: "Trail Geek", merchant: "Lumen Skincare" } });

    expect(out.mode).toBe("llm");
    expect(prompts[0]!.prompt).toContain("Circling back, Trail Geek — our spring bundle offer for partners closes Friday."); // the step copy, tokens filled
    expect(prompts[0]!.prompt).toMatch(/step 2/i);
    expect(prompts[0]!.prompt).toMatch(/follow-up/i);
    expect(prompts[0]!.system).toMatch(/FOLLOW-UP/);
    expect(prompts[0]!.system).toMatch(/merchant's own copy/);
  });

  it("the first-touch prompt carries its step copy as well, and a fenced JSON answer is accepted", async () => {
    const { llm, prompts } = capturing('```json\n{"subject":"Loved your reviews","body":"Hi — your trail shoe reviews are great. Would you be open to hearing about our partner program for creators like you?"}\n```');
    const deps = makeDeps(await seededDb(), { llm });
    const step = { step: 1, delayDays: 0, kind: "initial" as const, subject: "Partnering with {{merchant}}", body: "Hi {{name}}, we pay 20% to partners." };
    const out = await personalizeOutreach(deps, { merchant: merchantRow({ personalizationPlan: "llm" }), prospect: prospectRow(), step, tokens: { name: "Trail Geek", merchant: "Lumen Skincare" } });
    expect(out).toMatchObject({ mode: "llm", subject: "Loved your reviews" }); // not thrown away for the ``` fence
    expect(prompts[0]!.prompt).toContain("Hi Trail Geek, we pay 20% to partners.");
    expect(prompts[0]!.system).not.toMatch(/FOLLOW-UP/);
  });

  it("a class the model invents is not stored — the keyword classifier decides instead", async () => {
    for (const invented of ['{"classification":"spam"}', '{"classification":"POSITIVE"}', '{"classification":42}', "I think they are interested."]) {
      const db = await seededDb();
      const p = await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com", state: "contacted" }));
      const out = await handleReply(makeDeps(db, { llm: capturing(invented).llm }), p.id, "Sounds good, tell me more about the commission.");
      expect(out.classification).toBe("interested"); // the keyword classifier's answer
      expect(["interested", "question", "not_interested", "out_of_office", "unsubscribe", "unknown"]).toContain((await db.replies.all())[0]!.classification);
    }
  });

  it("a valid class from the model is used, and STOP beats whatever the model says", async () => {
    const db = await seededDb();
    const p = await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com", state: "contacted" }));
    const deps = makeDeps(db, { llm: capturing('{"classification":"not_interested"}').llm });
    expect((await handleReply(deps, p.id, "We already work with someone else on this.")).classification).toBe("not_interested");
    const q = await db.prospects.insert(prospectRow({ id: "p2", email: "other@site.com", state: "contacted" }));
    expect((await handleReply(makeDeps(db, { llm: capturing('{"classification":"interested"}').llm }), q.id, "STOP please")).classification).toBe("unsubscribe");
  });
});
