import { useState } from "react";
import { api, pct, num } from "../api";
import { useApi, Card, Stat, Badge, PageHeader, EmptyState } from "../ui";

interface MailboxHealth {
  mailboxId: string;
  email: string;
  status: "connected" | "warming" | "error" | "disconnected";
  warmupStatus: "not_started" | "warming" | "ready";
  effectiveCap: number;
  sentToday: number;
  sent: number;
  bounced: number;
  bounceRate: number;
  circuitOpen: boolean;
  autoPausedReason: string | null;
}
interface Health { sent: number; bounced: number; bounceRate: number; complaintRate: number; circuitOpen: boolean }

/** A horizontal bounce-rate meter with the 2% bulk-sender ceiling marked. */
function BounceMeter({ rate }: { rate: number }) {
  const ceiling = 0.02;
  const width = Math.min(100, (rate / (ceiling * 2)) * 100); // 2% ceiling sits at the midpoint
  const over = rate > ceiling;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ position: "relative", height: 8, background: "var(--ink-850)", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${width}%`, height: "100%", background: over ? "var(--neg, #e5484d)" : "var(--acc)", transition: "width .3s" }} />
        <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 2, background: "var(--text-faint)" }} title="2% ceiling" />
      </div>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
        <span className={over ? "neg" : "faint"} style={{ fontSize: 11 }}>{pct(rate)} bounce</span>
        <span className="faint" style={{ fontSize: 11 }}>ceiling 2%</span>
      </div>
    </div>
  );
}

export function Deliverability() {
  const mailboxes = useApi<MailboxHealth[]>(() => api.get("/recruitment/deliverability/mailboxes"));
  const health = useApi<Health>(() => api.get("/recruitment/deliverability"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function runMonitor() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post<{ paused: string[]; warmed: string[] }>("/recruitment/deliverability/monitor", {});
      setMsg(`Monitor ran — ${r.paused.length} paused, ${r.warmed.length} graduated.`);
      mailboxes.reload(); health.reload();
    } catch (e: any) { setMsg(e?.message ?? "failed"); }
    finally { setBusy(false); }
  }
  async function resume(id: string) {
    setBusy(true);
    try { await api.post(`/mailboxes/${id}/resume`, {}); mailboxes.reload(); }
    finally { setBusy(false); }
  }

  const rows = mailboxes.data ?? [];
  const paused = rows.filter((m) => m.status === "error").length;

  return (
    <>
      <PageHeader
        title="Deliverability"
        crumb="THE SILENT KILLER · MONITORED PER MAILBOX"
        subtitle="Bounce rate, warmup, and daily cap for every sending mailbox. A mailbox that breaches the bounce ceiling is auto-paused out of rotation before it burns your domain — fix the list, then resume it."
        actions={<button className="btn sm" onClick={runMonitor} disabled={busy}>↻ Run monitor now</button>}
      />

      {msg && <div className="mt-8" style={{ fontSize: 13, color: "var(--acc)" }}>{msg}</div>}

      <div className="grid grid-4">
        <Stat label="Circuit breaker" value={<Badge kind={health.data?.circuitOpen ? "neg" : "pos"}>{health.data?.circuitOpen ? "OPEN" : "OK"}</Badge>} foot="account-wide guard" footClass="muted" />
        <Stat label="Sent (window)" value={health.data ? num(health.data.sent) : "—"} foot="across mailboxes" footClass="muted" small />
        <Stat label="Bounce rate" value={health.data ? pct(health.data.bounceRate) : "—"} foot="keep < 2%" footClass={health.data && health.data.bounceRate > 0.02 ? "neg" : "muted"} small />
        <Stat label="Auto-paused" value={paused} foot="mailboxes out of rotation" footClass={paused ? "neg" : "muted"} small />
      </div>

      {mailboxes.error && <div className="err-banner">{mailboxes.error}</div>}

      <div className="mt-24">
        {mailboxes.loading ? null : rows.length === 0 ? (
          <EmptyState title="No mailboxes connected" hint="Connect a sending mailbox in Integrations to start monitoring deliverability." />
        ) : (
          <div className="grid grid-2" style={{ gap: 14 }}>
            {rows.map((m) => (
              <Card key={m.mailboxId}>
                <div className="row wrap gap-8" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <strong className="mono" style={{ fontSize: 13 }}>{m.email}</strong>
                  <div className="row gap-8">
                    <Badge kind={m.warmupStatus === "ready" ? "pos" : m.warmupStatus === "warming" ? "warn" : ""}>{m.warmupStatus.replace(/_/g, " ")}</Badge>
                    <Badge kind={m.status === "connected" ? "pos" : m.status === "error" ? "neg" : "warn"}>{m.status === "error" ? "paused" : m.status}</Badge>
                  </div>
                </div>

                <BounceMeter rate={m.bounceRate} />

                <div className="row wrap gap-8 mt-16" style={{ fontSize: 12 }}>
                  <span className="faint">{num(m.sent)} sent · {m.bounced} bounced</span>
                  <span className="faint">·</span>
                  <span className="faint">{m.sentToday}/{m.effectiveCap} today</span>
                </div>

                {m.status === "error" && (
                  <div style={{ marginTop: 12, padding: "8px 10px", background: "color-mix(in srgb, var(--neg, #e5484d) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--neg, #e5484d) 30%, var(--line))", borderRadius: 8 }}>
                    <div className="neg" style={{ fontSize: 12 }}>{m.autoPausedReason ?? "paused"}</div>
                    <button className="btn sm mt-8" onClick={() => resume(m.mailboxId)} disabled={busy}>Resume mailbox</button>
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
