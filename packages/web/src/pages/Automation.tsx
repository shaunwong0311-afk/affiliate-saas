import { useState } from "react";
import { api, pct, num } from "../api";
import { useApi, Card, Stat, Badge, PageHeader, EmptyState, Field } from "../ui";
import { navigate } from "../router";

interface AutomationState {
  status: "off" | "running" | "paused";
  autoSendMinScore: number;
  hitlTier: "A" | "B" | "C";
  meetingTier: "A" | "B" | "C";
  sourcingLimitPerCycle: number;
  lastCycleAt: string | null;
}
interface Deliverability { sent: number; bounceRate: number; complaintRate: number; circuitOpen: boolean }
interface SourceYieldRow { sourceType: string; sourced: number; contacted: number; producing: number; producedRevenueCents: number; yield: number }
interface Meeting { id: string; prospectId: string; status: string; bookingUrl: string | null; notes: string | null; createdAt: string }
interface CycleSummary { sourced: number; scored: number; autoSent: number; followUpsSent: number; heldForReview: number; circuitOpen: boolean; prunedSources: string[] }

export function Automation() {
  const auto = useApi<AutomationState>(() => api.get("/recruitment/automation"));
  const deliver = useApi<Deliverability>(() => api.get("/recruitment/deliverability"));
  const yields = useApi<SourceYieldRow[]>(() => api.get("/recruitment/source-yield"));
  const meetings = useApi<Meeting[]>(() => api.get("/recruitment/meetings"));
  const [busy, setBusy] = useState(false);
  const [lastCycle, setLastCycle] = useState<CycleSummary | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reloadAll = () => { auto.reload(); deliver.reload(); yields.reload(); meetings.reload(); };

  async function patch(body: Partial<AutomationState>) {
    setBusy(true);
    try { await api.put("/recruitment/automation", body); auto.reload(); }
    catch (e: any) { setMsg(e?.message ?? "failed"); }
    finally { setBusy(false); }
  }
  async function runCycle() {
    setBusy(true); setMsg(null);
    try { setLastCycle(await api.post<CycleSummary>("/recruitment/automation/cycle", {})); reloadAll(); }
    catch (e: any) { setMsg(e?.message ?? "failed"); }
    finally { setBusy(false); }
  }

  if (auto.loading) return null;
  const s = auto.data;
  const running = s?.status === "running";

  return (
    <>
      <PageHeader
        title="Autonomous engine"
        crumb="FROM SCRATCH · L4 WITH HITL GATES"
        subtitle="Connect a store + mailbox and the engine sources the open web, enriches, scores, sends as you, sequences, and routes replies — A-tier held for your approval, everything else automated. Your job: approve and monitor."
        actions={
          <>
            <button className="btn" onClick={runCycle} disabled={busy}>↻ Run one cycle</button>
            {running ? (
              <button className="btn" onClick={() => patch({ status: "paused" })} disabled={busy}>Pause</button>
            ) : (
              <button className="btn primary" onClick={() => patch({ status: "running" })} disabled={busy}>▶ Start automation</button>
            )}
          </>
        }
      />

      {msg && <div className="err-banner">{msg}</div>}

      <div className="grid grid-4">
        <Stat label="Automation" value={<Badge kind={running ? "pos" : s?.status === "paused" ? "warn" : ""}>{s?.status}</Badge>} foot={s?.lastCycleAt ? "last cycle recorded" : "no cycle yet"} footClass="muted" />
        <Stat label="Auto-send threshold" value={`≥ ${s?.autoSendMinScore}`} foot="score to auto-advance" footClass="muted" small />
        <Stat label="Deliverability" value={deliver.data ? `${num(deliver.data.sent)} sent` : "—"} foot={deliver.data ? `bounce ${pct(deliver.data.bounceRate)}` : ""} footClass={deliver.data?.circuitOpen ? "neg" : "muted"} small />
        <Stat label="Circuit breaker" value={<Badge kind={deliver.data?.circuitOpen ? "neg" : "pos"}>{deliver.data?.circuitOpen ? "OPEN" : "OK"}</Badge>} foot="bounce/complaint guard" footClass="muted" />
      </div>

      {lastCycle && (
        <Card title="Last cycle" sub="one autonomous pass" >
          <div className="row wrap gap-8 mt-16">
            <Badge>sourced {lastCycle.sourced}</Badge>
            <Badge kind="pos">auto-sent {lastCycle.autoSent}</Badge>
            <Badge kind="info">follow-ups {lastCycle.followUpsSent}</Badge>
            <Badge kind="warn">held for review {lastCycle.heldForReview}</Badge>
            {lastCycle.circuitOpen && <Badge kind="neg">circuit open</Badge>}
            {lastCycle.prunedSources.map((p) => <Badge key={p}>pruned: {p}</Badge>)}
          </div>
          {lastCycle.heldForReview > 0 && (
            <div className="mt-16"><button className="btn sm" onClick={() => navigate("/recruitment")}>Review held prospects →</button></div>
          )}
        </Card>
      )}

      <div className="grid grid-2 mt-24">
        <Card title="Gates & thresholds" sub="where the humans stay in the loop">
          <Field label="Auto-send minimum score (0–100)">
            <input className="input" type="number" min={0} max={100} value={s?.autoSendMinScore ?? 70}
              onChange={(e) => patch({ autoSendMinScore: Number(e.target.value) })} />
          </Field>
          <Field label="HITL tier — at/above this tier a human approves before the first send">
            <select className="select" value={s?.hitlTier} onChange={(e) => patch({ hitlTier: e.target.value as any })}>
              <option value="A">A only (recommended)</option>
              <option value="B">A + B</option>
              <option value="C">All tiers (everything gated)</option>
            </select>
          </Field>
          <Field label="Meeting tier — at/above this tier an interested reply books a call">
            <select className="select" value={s?.meetingTier} onChange={(e) => patch({ meetingTier: e.target.value as any })}>
              <option value="A">A only (recommended)</option>
              <option value="B">A + B</option>
              <option value="C">All tiers</option>
            </select>
          </Field>
          <Field label="Sourcing per cycle">
            <input className="input" type="number" min={1} max={200} value={s?.sourcingLimitPerCycle ?? 20}
              onChange={(e) => patch({ sourcingLimitPerCycle: Number(e.target.value) })} />
          </Field>
          <p className="faint" style={{ fontSize: 12 }}>Long-tail (below meeting tier) interested replies get an AI-SDR answer + self-serve signup. A-tier books a meeting on your calendar with an owner assigned.</p>
        </Card>

        <Card flush title="Source yield" sub="producing / sourced — prune what doesn't produce">
          {!yields.data || yields.data.length === 0 ? (
            <div style={{ padding: 20 }}><EmptyState title="No source data yet" hint="Run a cycle to start sourcing." /></div>
          ) : (
            <table className="table">
              <thead><tr><th>Source</th><th className="num">Sourced</th><th className="num">Producing</th><th className="num">Yield</th></tr></thead>
              <tbody>
                {yields.data.map((y) => (
                  <tr key={y.sourceType}>
                    <td>{y.sourceType.replace(/_/g, " ")}</td>
                    <td className="num">{y.sourced}</td>
                    <td className="num">{y.producing}</td>
                    <td className="num"><Badge kind={y.yield > 0.05 ? "pos" : y.sourced >= 20 ? "neg" : ""}>{pct(y.yield)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="mt-24">
        <Card flush title="Warm replies & meetings" sub="the managed, human-closed track">
          {!meetings.data || meetings.data.length === 0 ? (
            <div style={{ padding: 20 }}><EmptyState title="No meetings yet" hint="When an A-tier prospect replies interested, the AI-SDR books a call here." /></div>
          ) : (
            <table className="table">
              <thead><tr><th>Prospect</th><th>Status</th><th>Booking</th><th>Notes</th></tr></thead>
              <tbody>
                {meetings.data.map((m) => (
                  <tr key={m.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{m.prospectId.slice(-8)}</td>
                    <td><Badge kind={m.status === "completed" ? "pos" : m.status === "cancelled" ? "neg" : "warn"}>{m.status}</Badge></td>
                    <td>{m.bookingUrl ? <a className="acc" href={m.bookingUrl} target="_blank" rel="noreferrer">link</a> : <span className="faint">—</span>}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{m.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
