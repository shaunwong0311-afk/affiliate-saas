import { describe, it, expect } from "vitest";
import { applyToJoin, queueFirstTouch, send } from "../src/index.js";
import { FakeSender, makeDeps, prospectRow, seededDb } from "./helpers/outreach.js";

/**
 * AUDIT-2026-10 (integration follow-ups).
 *
 * 1. A synthetic (demo) prospect carries an invented address at a plausible domain. It may go
 *    to the mock sender in dev, never through a real mailbox.
 * 2. The public join form trusts the `prospectId` from the signup link only when it names a
 *    prospect of the SAME merchant.
 */
describe("demo prospects never leave through a real mailbox", () => {
  it("a real sender is never handed a synthetic prospect; the message fails with the reason", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "p1", email: "skincare.reviewer@skincarecreator1.com", synthetic: true }));
    const real = new FakeSender(); // provider "fake" — anything that is not the mock counts as real
    const deps = makeDeps(db, { mailer: real });

    const out = await send(deps, (await queueFirstTouch(deps, "p1", await db.campaigns.require("c1")))!.id);

    expect(real.sent).toHaveLength(0);
    expect(out.status).toBe("failed");
    expect(`${out.blockedReason ?? ""}${out.deliveryError ?? ""}`).toMatch(/demo prospect/);
  });

  it("a real prospect still sends through the same sender", async () => {
    const db = await seededDb();
    await db.prospects.insert(prospectRow({ id: "p1", email: "creator@site.com", synthetic: false }));
    const real = new FakeSender();
    const deps = makeDeps(db, { mailer: real });

    const out = await send(deps, (await queueFirstTouch(deps, "p1", await db.campaigns.require("c1")))!.id);

    expect(real.sent).toHaveLength(1);
    expect(out.status).toBe("sent");
  });
});

describe("public join keeps the recruit attributed to the prospect", () => {
  it("links a prospect of the same merchant and ignores one that belongs to another merchant", async () => {
    const db = await seededDb();
    const deps = makeDeps(db, {});
    await db.programs.insert({ id: "prog1", merchantId: "m1", name: "Default", status: "active", termsUrl: null, approvalMode: "manual", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 14 });
    await db.prospects.insert(prospectRow({ id: "p_mine", email: "creator@site.com", source: "backlink_mining" }));
    await db.prospects.insert({ ...prospectRow({ id: "p_other", email: "x@other.com" }), merchantId: "someone-else" });

    const mine = await applyToJoin(deps, "m1", { email: "creator@site.com", name: "Creator", prospectId: "p_mine" });
    const relMine = await db.relationships.require(mine!.relationshipId);
    expect(relMine.prospectId).toBe("p_mine");
    expect(relMine.source).toBe("backlink_mining");

    const other = await applyToJoin(deps, "m1", { email: "stranger@elsewhere.com", name: "Stranger", prospectId: "p_other" });
    const relOther = await db.relationships.require(other!.relationshipId);
    expect(relOther.prospectId).toBeNull();
    expect(relOther.source).toBe("inbound_apply");
  });
});
