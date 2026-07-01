import { useState } from "react";
import { api, shortDate } from "../api";
import { useApi, Card, Badge, PageHeader, EmptyState, Stat } from "../ui";

interface DmTask {
  id: string;
  prospectId: string;
  step: number;
  platform: string;
  handle: string;
  deepLink: string | null;
  opensComposer: boolean;
  message: string;
  context: string;
  status: "pending" | "sent" | "skipped";
  createdAt: string;
  prospect: { identity: string; tier: "A" | "B" | "C" | null; score: number | null } | null;
}

const PLATFORM_ICON: Record<string, string> = { instagram: "◉", twitter: "𝕏", tiktok: "♪", telegram: "✈" };

export function DmQueue() {
  const [status, setStatus] = useState<"pending" | "sent" | "skipped">("pending");
  const { data, loading, error, reload } = useApi<DmTask[]>(() => api.get(`/recruitment/dm-tasks?status=${status}`), [status]);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function markSent(id: string) {
    setBusy(id);
    try { await api.post(`/recruitment/dm-tasks/${id}/sent`, {}); reload(); }
    finally { setBusy(null); }
  }
  async function skip(id: string) {
    setBusy(id);
    try { await api.post(`/recruitment/dm-tasks/${id}/skip`, {}); reload(); }
    finally { setBusy(null); }
  }
  async function copy(id: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied((c) => (c === id ? null : c)), 1600); } catch { /* ignore */ }
  }

  const rows = (data ?? []).filter((t) => t.status !== "skipped" || status === "skipped");
  const pending = rows.filter((t) => t.status === "pending").length;

  return (
    <>
      <PageHeader
        title="DM queue"
        crumb="MULTICHANNEL · SEMI-ASSISTED"
        subtitle="Prepared social DMs from your sequences — the message is drafted, the best handle picked from the identity graph, and a deep link opens the native composer. You press send (we never auto-DM — it's against platform rules). Copy, open, send, mark done."
        actions={
          <div className="row gap-8">
            <button className={`btn sm${status === "pending" ? " primary" : ""}`} onClick={() => setStatus("pending")}>Pending</button>
            <button className={`btn sm${status === "sent" ? " primary" : ""}`} onClick={() => setStatus("sent")}>Sent</button>
            <button className={`btn sm${status === "skipped" ? " primary" : ""}`} onClick={() => setStatus("skipped")}>Skipped</button>
          </div>
        }
      />

      <div className="grid grid-3">
        <Stat label="Ready to send" value={pending} foot="drafted + deep-linked" footClass="muted" />
        <Stat label="Platforms" value={new Set(rows.map((t) => t.platform).filter(Boolean)).size} foot="reach where they answer" footClass="muted" small />
        <Stat label="A-tier in queue" value={rows.filter((t) => t.prospect?.tier === "A").length} foot="prioritize these" footClass="muted" small />
      </div>

      {error && <div className="err-banner">{error}</div>}

      <div className="mt-24">
        {loading ? null : rows.length === 0 ? (
          <EmptyState title={status === "pending" ? "No DMs waiting" : `No ${status} DMs`} hint={status === "pending" ? "When a sequence hits a DM step, a fully-prepared task appears here." : undefined} />
        ) : (
          <div className="grid" style={{ gap: 14 }}>
            {rows.map((t) => (
              <Card key={t.id}>
                <div className="row wrap gap-8" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <div className="row wrap gap-8" style={{ alignItems: "center" }}>
                    <span style={{ fontSize: 16 }}>{PLATFORM_ICON[t.platform] ?? "✦"}</span>
                    <strong>{t.prospect?.identity ?? t.prospectId.slice(-8)}</strong>
                    {t.prospect?.tier && <Badge kind={t.prospect.tier === "A" ? "neg" : t.prospect.tier === "B" ? "warn" : ""}>{t.prospect.tier}</Badge>}
                    <span className="faint mono" style={{ fontSize: 12 }}>@{t.handle} · {t.platform} · step {t.step}</span>
                  </div>
                  <span className="faint" style={{ fontSize: 12 }}>{shortDate(t.createdAt)}</span>
                </div>

                {t.context && <p className="muted" style={{ margin: "10px 0 0", fontSize: 12 }}>{t.context}</p>}

                <div style={{ marginTop: 12, padding: "10px 12px", background: "var(--ink-850)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>{t.message}</div>

                {t.status === "pending" && (
                  <div className="row wrap gap-8 mt-16">
                    <button className="btn sm" onClick={() => copy(t.id, t.message)}>{copied === t.id ? "✓ copied" : "Copy message"}</button>
                    {t.deepLink && (
                      <a className="btn sm" href={t.deepLink} target="_blank" rel="noreferrer">{t.opensComposer ? "Open DM composer ↗" : "Open profile ↗"}</a>
                    )}
                    <button className="btn sm primary" onClick={() => markSent(t.id)} disabled={busy === t.id}>Mark sent</button>
                    <button className="btn sm ghost" onClick={() => skip(t.id)} disabled={busy === t.id}>Skip</button>
                  </div>
                )}
                {t.status !== "pending" && <div className="mt-16"><Badge kind={t.status === "sent" ? "pos" : ""}>{t.status}</Badge></div>}
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
