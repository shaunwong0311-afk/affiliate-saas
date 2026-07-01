import { useState } from "react";
import { api, shortDate } from "../api";
import { useApi, Card, Badge, PageHeader, EmptyState, Stat } from "../ui";

interface Handoff {
  id: string;
  prospectId: string;
  topic: string;
  intent: string;
  tier: "A" | "B" | "C" | null;
  reason: "gated_topic" | "ungrounded" | "approval" | "high_value";
  summary: string;
  suggestedReply: string | null;
  transcript: string;
  status: "open" | "resolved";
  createdAt: string;
}

const REASON_LABEL: Record<Handoff["reason"], string> = {
  gated_topic: "Needs a human",
  ungrounded: "AI couldn't answer",
  approval: "Approve & send",
  high_value: "A-tier — warm",
};
const REASON_KIND: Record<Handoff["reason"], string> = { gated_topic: "warn", ungrounded: "info", approval: "pos", high_value: "neg" };

export function Handoffs() {
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const { data, loading, error, reload } = useApi<Handoff[]>(() => api.get(`/recruitment/handoffs?status=${status}`), [status]);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function resolve(id: string) {
    setBusy(id);
    try { await api.post(`/recruitment/handoffs/${id}/resolve`, {}); reload(); }
    finally { setBusy(null); }
  }
  async function copy(id: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied((c) => (c === id ? null : c)), 1600); } catch { /* ignore */ }
  }

  const rows = data ?? [];
  const open = rows.filter((h) => h.status === "open");
  const aTier = open.filter((h) => h.tier === "A").length;

  return (
    <>
      <PageHeader
        title="Reply handoffs"
        crumb="AI-SDR · HUMAN-IN-THE-LOOP"
        subtitle="Every reply the AI-SDR routed to a person: gated topics (rate/deal/legal), questions it wouldn't guess at, and — in HITL mode — grounded answers waiting for your one-click approval. Work top to bottom; A-tier is time-sensitive."
        actions={
          <div className="row gap-8">
            <button className={`btn sm${status === "open" ? " primary" : ""}`} onClick={() => setStatus("open")}>Open</button>
            <button className={`btn sm${status === "resolved" ? " primary" : ""}`} onClick={() => setStatus("resolved")}>Resolved</button>
          </div>
        }
      />

      <div className="grid grid-3">
        <Stat label="Open handoffs" value={open.length} foot="awaiting you" footClass="muted" />
        <Stat label="A-tier waiting" value={aTier} foot="highest urgency" footClass={aTier ? "neg" : "muted"} />
        <Stat label="Approvals queued" value={open.filter((h) => h.reason === "approval").length} foot="AI drafted — one click to send" footClass="muted" small />
      </div>

      {error && <div className="err-banner">{error}</div>}

      <div className="mt-24">
        {loading ? null : rows.length === 0 ? (
          <EmptyState title={status === "open" ? "Nothing needs you right now" : "No resolved handoffs"} hint={status === "open" ? "When a reply needs a human, it lands here with the full context + a suggested reply." : undefined} />
        ) : (
          <div className="grid" style={{ gap: 14 }}>
            {rows.map((h) => (
              <Card key={h.id}>
                <div className="row wrap gap-8" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div className="row wrap gap-8" style={{ alignItems: "center" }}>
                    {h.tier && <Badge kind={h.tier === "A" ? "neg" : h.tier === "B" ? "warn" : ""}>{h.tier}-tier</Badge>}
                    <Badge kind={REASON_KIND[h.reason]}>{REASON_LABEL[h.reason]}</Badge>
                    <span className="mono faint" style={{ fontSize: 12 }}>{h.topic.replace(/_/g, " ")}</span>
                  </div>
                  <span className="faint" style={{ fontSize: 12 }}>{shortDate(h.createdAt)}</span>
                </div>

                <p style={{ margin: "12px 0 0", fontSize: 14 }}>{h.summary}</p>

                {h.transcript && (
                  <details style={{ marginTop: 10 }}>
                    <summary className="faint" style={{ fontSize: 12, cursor: "pointer" }}>Full message</summary>
                    <blockquote style={{ margin: "8px 0 0", padding: "10px 12px", borderLeft: "2px solid var(--line)", background: "var(--ink-850)", borderRadius: 6, fontSize: 13, whiteSpace: "pre-wrap" }}>{h.transcript}</blockquote>
                  </details>
                )}

                {h.suggestedReply && (
                  <div style={{ marginTop: 12 }}>
                    <div className="faint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>Suggested reply (grounded in your program facts)</div>
                    <div style={{ padding: "10px 12px", background: "color-mix(in srgb, var(--acc) 8%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 25%, var(--line))", borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>{h.suggestedReply}</div>
                  </div>
                )}

                {h.status === "open" && (
                  <div className="row gap-8 mt-16">
                    {h.suggestedReply && (
                      <button className="btn sm" onClick={() => copy(h.id, h.suggestedReply!)}>{copied === h.id ? "✓ copied" : "Copy reply"}</button>
                    )}
                    <button className="btn sm primary" onClick={() => resolve(h.id)} disabled={busy === h.id}>Mark resolved</button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
