import { describe, it, expect } from "vitest";
import { scanContent } from "../src/index.js";

describe("scanContent", () => {
  it("passes a clean, well-formed cold email", () => {
    const r = scanContent({
      subject: "Partnering with Lumen Skincare",
      body: "Hi Trail Geek — I saw your skincare reviews and your affiliate links. We run a program that pays 15% and I think you'd be a strong fit. Want the details?",
    });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("clean");
    expect(r.issues).toHaveLength(0);
  });

  it("blocks an empty subject or body", () => {
    expect(scanContent({ subject: "", body: "hello there friend" }).ok).toBe(false);
    expect(scanContent({ subject: "Hi", body: "" }).ok).toBe(false);
    expect(scanContent({ subject: "", body: "" }).issues.some((i) => i.code === "empty_subject")).toBe(true);
  });

  it("blocks egregious spam (severe pattern)", () => {
    const r = scanContent({ subject: "FREE MONEY!!!", body: "Get free money now, $$$ guaranteed income, act now!!!" });
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("block");
    expect(r.issues.some((i) => i.code === "severe_spam")).toBe(true);
  });

  it("blocks when many distinct spam phrases pile up", () => {
    const r = scanContent({ subject: "Act now", body: "Buy now, click here, limited time, risk-free, order now — apply now!" });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "spam_phrases" && i.severity === "block")).toBe(true);
  });

  it("warns (but still sends) on a single mild spam phrase", () => {
    const r = scanContent({ subject: "A quick idea for your channel", body: "We offer a small discount for your audience — happy to share the details if useful. Let me know!" });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("warn");
    expect(r.issues.some((i) => i.code === "spam_phrases")).toBe(true);
  });

  it("blocks an email stuffed with links and warns on shorteners", () => {
    const many = Array.from({ length: 9 }, (_, i) => `https://example.com/p${i}`).join(" ");
    expect(scanContent({ subject: "Links", body: `Check these out ${many}` }).ok).toBe(false);
    const short = scanContent({ subject: "One link", body: "Grab it here https://bit.ly/abc123 — thanks and let me know what you think!" });
    expect(short.issues.some((i) => i.code === "link_shortener")).toBe(true);
  });

  it("flags a faked Re:/Fwd: subject and ALL CAPS", () => {
    expect(scanContent({ subject: "Re: our chat", body: "just following up on the thing we never discussed before now ok" }).issues.some((i) => i.code === "fake_reply_subject")).toBe(true);
    expect(scanContent({ subject: "HUGE OPPORTUNITY HERE", body: "this is a normal enough body to isolate the subject caps check only" }).issues.some((i) => i.code === "subject_all_caps")).toBe(true);
  });
});
