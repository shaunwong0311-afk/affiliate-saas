import type { HttpClient } from "./mailbox.js";

/**
 * Handoff notifier (OUTREACH-SPEC §16 #11). When a reply needs a human — a gated topic, an
 * ungrounded question, or an A-tier reply awaiting approval — we notify the operator so warm
 * replies don't rot in a queue. The in-app handoff queue is always the source of truth; this
 * port is the PUSH layer on top (Slack / webhook / mobile push). Behind a port with a
 * deterministic stub so the whole flow runs offline; a real channel is wired by env.
 */
export interface HandoffNotification {
  merchantId: string;
  handoffId: string;
  /** Prospect tier, when known (drives urgency — A-tier warm replies are time-sensitive). */
  tier: "A" | "B" | "C" | null;
  topic: string;
  prospectName: string;
  summary: string;
  /** Where to action it (the operator handoff queue). */
  url?: string;
  urgency: "normal" | "high";
}

export interface Notifier {
  readonly channel: string;
  notify(n: HandoffNotification): Promise<void>;
}

/** Default: records notifications in-process (the in-app queue is the real store). Deterministic. */
export class StubNotifier implements Notifier {
  readonly channel = "stub";
  readonly sent: HandoffNotification[] = [];
  async notify(n: HandoffNotification): Promise<void> {
    this.sent.push(n);
  }
}

/**
 * Slack Incoming-Webhook notifier — real shape, key-gated. Posts a compact message so an
 * operator can jump straight to the handoff. Failures are swallowed (a push miss must never
 * break reply routing; the in-app queue still has it).
 */
export class SlackWebhookNotifier implements Notifier {
  readonly channel = "slack";
  constructor(private readonly opts: { webhookUrl: string; http: HttpClient }) {}
  async notify(n: HandoffNotification): Promise<void> {
    const prefix = n.urgency === "high" ? ":rotating_light: " : "";
    const text = `${prefix}*New reply needs you* — ${n.prospectName} (${n.tier ?? "?"}-tier, ${n.topic})\n${n.summary}${n.url ? `\n<${n.url}|Open handoff>` : ""}`;
    try {
      await this.opts.http.post(this.opts.webhookUrl, { text }, { "Content-Type": "application/json" });
    } catch {
      /* push is best-effort — the in-app handoff queue is the durable record */
    }
  }
}
