import { useState } from "react";
import { api, num } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState } from "../ui";

interface Prospect {
  id: string;
  identity: string;
  source: string;
  siteUrl: string | null;
  channelUrl: string | null;
  email: string | null;
  state: string;
  score: number | null;
  tier: "A" | "B" | "C" | null;
  scoreBreakdown: { explanation?: string[]; breakdown?: { factor: string; contribution: number; note: string }[] } | null;
}

export function Recruitment() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<Prospect | null>(null);
  const prospects = useApi<{ items: Prospect[]; total: number }>(() => api.get("/recruitment/prospects?limit=100"));
  const icp = useApi<{ niche: string | null; competitors: string[] }>(() => api.get("/recruitment/icp"));

  async function source() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.post<{ discovered: number; scored: number; byTier: Record<string, number> }>("/recruitment/source", { limit: 12 });
      setMsg(`Sourced ${res.discovered}, scored ${res.scored} — A:${res.byTier.A ?? 0} B:${res.byTier.B ?? 0} C:${res.byTier.C ?? 0}`);
      prospects.reload();
    } catch (e: any) {
      setMsg(e?.message ?? "failed");
    } finally {
      setBusy(false);
    }
  }

  async function approve(p: Prospect) {
    try {
      await api.post(`/recruitment/prospects/${p.id}/approve`, {});
      prospects.reload();
      setSelected(null);
    } catch (e: any) {
      setMsg(e?.message ?? "approve failed");
    }
  }

  if (prospects.loading) return <Spinner />;
  const items = prospects.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Recruitment engine"
        crumb="THE WEDGE"
        subtitle="Targeting is the moat, sending is the mechanism. We find who already promotes your competitors — proven affiliates in your exact niche — and score them for who will actually drive sales."
        actions={
          <button className="btn primary" onClick={source} disabled={busy}>
            {busy ? "sourcing…" : "⌖ Run sourcing"}
          </button>
        }
      />

      {msg && <div className="err-banner" style={{ background: "var(--acc-glow)", borderColor: "var(--acc-dim)", color: "var(--acc)" }}>{msg}</div>}
      {icp.data && (
        <div className="row gap-8" style={{ marginBottom: 18 }}>
          <Badge>niche: {icp.data.niche ?? "unset"}</Badge>
          {icp.data.competitors.length ? icp.data.competitors.map((c) => <Badge key={c} kind="info">vs {c}</Badge>) : <Badge kind="warn">no competitors set</Badge>}
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="No prospects yet"
          hint="Run sourcing to mine competitor affiliates, creators, and customers. Competitor-affiliate mining is the highest-signal source."
          action={<button className="btn primary" onClick={source} disabled={busy}>Run sourcing</button>}
        />
      ) : (
        <div className="grid grid-2">
          <Card flush title={`Prospect queue · ${items.length}`} sub="ranked by fit + propensity score">
            <div style={{ maxHeight: 560, overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Prospect</th>
                    <th>Source</th>
                    <th>Tier</th>
                    <th className="num">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                    <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => setSelected(p)}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{p.identity}</div>
                        <div className="faint mono" style={{ fontSize: 11 }}>{p.email ?? "no email"}</div>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{p.source.replace(/_/g, " ")}</td>
                      <td>{p.tier ? <Badge kind={`tier-${p.tier}`}>{p.tier}</Badge> : <span className="faint">—</span>}</td>
                      <td className="num">{p.score ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Why this prospect?" sub="explainability — every point is attributable">
            {!selected ? (
              <EmptyState title="Select a prospect" hint="See the score breakdown: competitor promoted, affiliate links detected, reach, engagement, contactability." />
            ) : (
              <div>
                <div className="row between" style={{ marginBottom: 4 }}>
                  <h3 style={{ fontSize: 18 }}>{selected.identity}</h3>
                  {selected.tier && <Badge kind={`tier-${selected.tier}`}>Tier {selected.tier} · {selected.score}</Badge>}
                </div>
                <div className="faint mono" style={{ fontSize: 12, marginBottom: 16 }}>
                  {selected.siteUrl ?? selected.channelUrl ?? "—"}
                </div>

                {selected.scoreBreakdown?.breakdown?.map((b) => (
                  <div className="factor-row" key={b.factor}>
                    <span className="muted" style={{ fontSize: 12.5 }}>{b.factor}</span>
                    <div className="scorebar">
                      <span style={{ width: `${Math.min(100, b.contribution * 3)}%` }} />
                    </div>
                    <span className="mono num" style={{ fontSize: 12 }}>+{b.contribution.toFixed(1)}</span>
                  </div>
                ))}

                <div className="card" style={{ background: "var(--ink-850)", marginTop: 16, padding: 14 }}>
                  {(selected.scoreBreakdown?.explanation ?? []).slice(0, 4).map((e, i) => (
                    <div key={i} className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>• {e}</div>
                  ))}
                </div>

                <div className="row gap-8 mt-16">
                  <button className="btn primary sm" onClick={() => approve(selected)} disabled={!selected.email}>
                    Approve → create affiliate
                  </button>
                  <button className="btn sm ghost" onClick={() => api.post(`/recruitment/prospects/${selected.id}/reject`, {}).then(() => { prospects.reload(); setSelected(null); })}>
                    Reject
                  </button>
                </div>
                {!selected.email && <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>No verified email — enrichment incomplete.</div>}
              </div>
            )}
          </Card>
        </div>
      )}

      <div className="mt-24">
        <Card title="Sourcing intelligence" sub="closed-loop: outcomes retrain scoring toward 'will drive sales'">
          <div className="grid grid-3 mt-16">
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Competitor mining</strong>
              <p style={{ marginTop: 4 }}>Scans for affiliate-link signatures pointing at your competitors. Proven affiliates, exact niche — the warmest target.</p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Creator discovery</strong>
              <p style={{ marginTop: 4 }}>YouTube, blogs, newsletters ranking for your terms. Filtered by reach, engagement, and existing affiliate activity.</p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Customer mining</strong>
              <p style={{ marginTop: 4 }}>Your own repeat buyers and high-NPS accounts who are themselves creators. Highest-converting source of all.</p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
