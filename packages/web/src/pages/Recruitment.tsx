import { useState } from "react";
import { api, num } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState } from "../ui";

interface Account {
  platform: string;
  handle: string | null;
  url: string;
  provenance: string;
  confidence: number;
}
interface Profile {
  primary: Account | null;
  accounts: Account[];
  audience: { reach: number | null; primaryGeo: string | null; language: string | null; engagementRate: number | null; source: string | null };
  identityConfidence: number;
}
interface Evidence {
  affiliateLinks?: { url: string; network: string; confidence: string; verified?: boolean }[];
  competitorPromoted?: string | null;
  contactSource?: string | null;
  contactEmails?: { email: string; source: string }[];
  contactUrls?: { url: string; kind: string }[];
  contactForm?: boolean;
  contactFormUrl?: string | null;
  profile?: Profile | null;
  pageUrl?: string | null;
}

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
  synthetic: boolean;
  confidence: number | null;
  evidence: Evidence | null;
  scoreBreakdown: { explanation?: string[]; breakdown?: { factor: string; contribution: number; note: string }[]; unknownFactors?: string[] } | null;
}

interface OutreachMessage {
  id: string;
  step: number;
  variant: string;
  subject: string;
  sentAt: string | null;
  status: string; // queued | sent | bounced | failed
}
interface Reply {
  id: string;
  classification: string; // interested | question | not_interested | unsubscribe | auto_reply | other
  ts: string;
}

// Map a prospect state to a compact outreach-status badge for the queue.
const OUTREACH_STATE: Record<string, { label: string; kind: string }> = {
  contacted: { label: "contacted", kind: "info" },
  in_sequence: { label: "in sequence", kind: "info" },
  replied: { label: "replied", kind: "pos" },
  converted: { label: "converted", kind: "pos" },
  bounced: { label: "bounced", kind: "neg" },
  suppressed: { label: "suppressed", kind: "neg" },
  dead: { label: "dead", kind: "" },
};

const PLATFORM_ICONS: Record<string, string> = {
  youtube: "▶", twitter: "𝕏", instagram: "◙", tiktok: "♪", substack: "✉", beehiiv: "🐝",
  podcast: "🎙", linktree: "🌳", website: "🌐", unknown: "•",
};
function platformIcon(platform: string): string {
  return PLATFORM_ICONS[platform] ?? "•";
}

export function Recruitment() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<Prospect | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string; formUrl: string | null } | null>(null);
  const [activity, setActivity] = useState<{ messages: OutreachMessage[]; replies: Reply[] } | null>(null);
  const prospects = useApi<{ items: Prospect[]; total: number }>(() => api.get("/recruitment/prospects?limit=100"));
  const icp = useApi<{ niche: string | null; competitors: string[] }>(() => api.get("/recruitment/icp"));

  async function source() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.post<{ discovered: number; scored: number; byTier: Record<string, number>; real: number; synthetic: number }>("/recruitment/source", { limit: 12 });
      const demoNote = res.synthetic > 0 ? ` · ${res.real} real, ${res.synthetic} demo` : "";
      setMsg(`Sourced ${res.discovered}, scored ${res.scored} — A:${res.byTier.A ?? 0} B:${res.byTier.B ?? 0} C:${res.byTier.C ?? 0}${demoNote}`);
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

  function select(p: Prospect) {
    setSelected(p);
    setDraft(null); // clear any stale contact-form draft
    setActivity(null);
    // Pull the full outreach history (touches + replies) for the timeline.
    api
      .get<{ messages: OutreachMessage[]; replies: Reply[] }>(`/recruitment/prospects/${p.id}`)
      .then((d) => setActivity({ messages: d.messages ?? [], replies: d.replies ?? [] }))
      .catch(() => setActivity({ messages: [], replies: [] }));
  }

  async function loadDraft(p: Prospect) {
    try {
      const d = await api.get<{ subject: string; body: string; formUrl: string | null }>(`/recruitment/prospects/${p.id}/contact-draft`);
      setDraft(d);
    } catch (e: any) {
      setMsg(e?.message ?? "could not load draft");
    }
  }

  if (prospects.loading) return <Spinner />;
  const items = prospects.data?.items ?? [];
  const syntheticCount = items.filter((p) => p.synthetic).length;

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
      {syntheticCount > 0 && (
        <div
          className="err-banner"
          style={{ background: "rgba(245, 180, 60, 0.10)", borderColor: "rgba(245, 180, 60, 0.45)", color: "#f5b43c", marginBottom: 14 }}
        >
          ⚠ {syntheticCount} of {items.length} prospects are <strong>demo data</strong> from deterministic generators (no SERP/email keys wired). Sourced/verified/tier counts that include them are illustrative, not real affiliates. Set <span className="mono">SERPAPI_KEY</span> + <span className="mono">HUNTER_API_KEY</span> for live discovery.
        </div>
      )}
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
                    <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => select(p)}>
                      <td>
                        <div style={{ fontWeight: 600 }} className="row gap-8">
                          {p.identity}
                          {p.synthetic && <Badge kind="warn">demo</Badge>}
                          {OUTREACH_STATE[p.state] && <Badge kind={OUTREACH_STATE[p.state].kind}>{OUTREACH_STATE[p.state].label}</Badge>}
                        </div>
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
                  <h3 style={{ fontSize: 18 }} className="row gap-8">
                    {selected.identity}
                    {selected.synthetic && <Badge kind="warn">demo data</Badge>}
                  </h3>
                  {selected.tier && <Badge kind={`tier-${selected.tier}`}>Tier {selected.tier} · {selected.score}</Badge>}
                </div>
                <div className="row gap-8" style={{ marginBottom: 16 }}>
                  <span className="faint mono" style={{ fontSize: 12 }}>{selected.siteUrl ?? selected.channelUrl ?? "—"}</span>
                  {selected.confidence != null && (
                    <Badge kind={selected.confidence >= 0.66 ? "pos" : selected.confidence >= 0.4 ? "info" : "warn"}>
                      {Math.round(selected.confidence * 100)}% confidence
                    </Badge>
                  )}
                </div>

                {selected.synthetic && (
                  <div className="err-banner" style={{ background: "rgba(245, 180, 60, 0.10)", borderColor: "rgba(245, 180, 60, 0.4)", color: "#f5b43c", fontSize: 12, marginBottom: 14 }}>
                    Synthetic demo prospect — generated offline, not a real person. Wire a SERP/email provider for live discovery.
                  </div>
                )}

                <div className="card" style={{ background: "var(--ink-850)", marginBottom: 14, padding: 14 }}>
                  <div className="faint" style={{ fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 8 }}>Outreach history</div>
                  {!activity ? (
                    <span className="faint" style={{ fontSize: 12 }}>loading…</span>
                  ) : (
                    (() => {
                      const sent = activity.messages.filter((m) => m.status === "sent");
                      const followUps = sent.filter((m) => m.step > 1).length;
                      const bounced = activity.messages.some((m) => m.status === "bounced") || selected.state === "bounced";
                      const lastSent = sent.map((m) => m.sentAt).filter(Boolean).sort().slice(-1)[0] ?? null;
                      if (sent.length === 0 && activity.replies.length === 0) {
                        return <div className="muted" style={{ fontSize: 12.5 }}>Not contacted yet — still in discovery/scoring.</div>;
                      }
                      const events = [
                        ...activity.messages
                          .filter((m) => m.sentAt || m.status !== "queued")
                          .map((m) => ({ ts: m.sentAt ?? "", label: `Touch ${m.step} ${m.status}${m.variant ? ` · ${m.variant}` : ""}`, kind: m.status === "bounced" ? "neg" : m.status === "sent" ? "info" : "" })),
                        ...activity.replies.map((r) => ({
                          ts: r.ts,
                          label: `Reply · ${r.classification.replace(/_/g, " ")}`,
                          kind: r.classification === "interested" ? "pos" : r.classification === "unsubscribe" || r.classification === "not_interested" ? "neg" : "warn",
                        })),
                      ]
                        .filter((e) => e.ts)
                        .sort((a, b) => b.ts.localeCompare(a.ts));
                      return (
                        <>
                          <div className="row wrap gap-8" style={{ marginBottom: 10 }}>
                            <Badge kind="info">{sent.length} touch{sent.length === 1 ? "" : "es"} sent</Badge>
                            {followUps > 0 && <Badge>{followUps} follow-up{followUps === 1 ? "" : "s"}</Badge>}
                            {activity.replies.length > 0 ? (
                              <Badge kind="pos">{activity.replies.length} repl{activity.replies.length === 1 ? "y" : "ies"}</Badge>
                            ) : (
                              <Badge>no reply yet</Badge>
                            )}
                            {bounced && <Badge kind="neg">bounced</Badge>}
                            {lastSent && <span className="faint" style={{ fontSize: 11, alignSelf: "center" }}>last touch {new Date(lastSent).toLocaleDateString()}</span>}
                          </div>
                          <div style={{ borderLeft: "2px solid var(--line)", paddingLeft: 12 }}>
                            {events.map((e, i) => (
                              <div key={i} className="row gap-8" style={{ marginBottom: 6, alignItems: "baseline" }}>
                                <span className="faint mono" style={{ fontSize: 11, minWidth: 74 }}>{new Date(e.ts).toLocaleDateString()}</span>
                                <Badge kind={e.kind}>{e.label}</Badge>
                              </div>
                            ))}
                          </div>
                        </>
                      );
                    })()
                  )}
                </div>

                {selected.scoreBreakdown?.breakdown?.filter((b) => b.contribution > 0).map((b) => (
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
                  {selected.scoreBreakdown?.unknownFactors?.length ? (
                    <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
                      Unknown (no data provider): {selected.scoreBreakdown.unknownFactors.join(", ")} — excluded from the score, not invented.
                    </div>
                  ) : null}
                </div>

                {selected.evidence && (
                  <div className="card" style={{ background: "var(--ink-850)", marginTop: 12, padding: 14 }}>
                    <div className="faint" style={{ fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 8 }}>Evidence</div>
                    {selected.evidence.competitorPromoted ? (
                      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
                        Promotes competitor: <span className="acc mono">{selected.evidence.competitorPromoted}</span>
                      </div>
                    ) : null}
                    {selected.evidence.pageUrl ? (
                      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
                        Found on: <a href={selected.evidence.pageUrl} target="_blank" rel="noreferrer" className="mono" style={{ color: "var(--acc)" }}>{selected.evidence.pageUrl}</a>
                      </div>
                    ) : null}
                    {selected.evidence.contactSource ? (
                      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
                        Contact via: <span className="mono">{selected.evidence.contactSource}</span>
                        {selected.evidence.contactSource === "pattern-guess" && <span className="faint"> (guessed pattern — lower trust)</span>}
                      </div>
                    ) : null}
                    {selected.evidence.affiliateLinks?.length ? (
                      <div style={{ marginTop: 6 }}>
                        <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>Affiliate links detected ({selected.evidence.affiliateLinks.length}):</div>
                        {selected.evidence.affiliateLinks.slice(0, 4).map((l, i) => (
                          <div key={i} className="row gap-8" style={{ marginBottom: 3 }}>
                            <Badge kind={l.confidence === "high" ? "pos" : "warn"}>{l.confidence}</Badge>
                            <span className="mono faint" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{l.network}: {l.url}</span>
                            {l.verified && <Badge kind="info">resolved</Badge>}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="faint" style={{ fontSize: 12 }}>No affiliate links detected on the page.</div>
                    )}
                  </div>
                )}

                {selected.evidence?.profile && selected.evidence.profile.accounts.length > 1 && (
                  <div className="card" style={{ background: "var(--ink-850)", marginTop: 12, padding: 14 }}>
                    <div className="row between" style={{ marginBottom: 8 }}>
                      <span className="faint" style={{ fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase" }}>Identity graph</span>
                      <span className="faint" style={{ fontSize: 11 }}>{Math.round(selected.evidence.profile.identityConfidence * 100)}% linked</span>
                    </div>
                    <div className="row wrap gap-8">
                      {selected.evidence.profile.accounts.map((a, i) => (
                        <a
                          key={i}
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          title={`${a.provenance.replace(/_/g, " ")} · ${Math.round(a.confidence * 100)}% confidence`}
                          style={{ textDecoration: "none" }}
                        >
                          <Badge kind={a.provenance === "seed" ? "info" : a.confidence >= 0.85 ? "pos" : ""}>
                            {platformIcon(a.platform)} {a.handle ?? a.platform}
                          </Badge>
                        </a>
                      ))}
                    </div>
                    <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>
                      Surfaces this creator owns, unified from the links they published. Audience demographics (geo/size) fill in once a provider is wired.
                    </div>
                  </div>
                )}

                <div className="row gap-8 mt-16">
                  <button className="btn primary sm" onClick={() => approve(selected)} disabled={!selected.email}>
                    Approve → create affiliate
                  </button>
                  <button className="btn sm ghost" onClick={() => api.post(`/recruitment/prospects/${selected.id}/reject`, {}).then(() => { prospects.reload(); setSelected(null); })}>
                    Reject
                  </button>
                </div>
                {!selected.email && !selected.evidence?.contactForm && (
                  <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>No verified email — enrichment incomplete.</div>
                )}

                {!selected.email && selected.evidence?.contactForm && (
                  <div className="card" style={{ background: "var(--ink-850)", marginTop: 14, padding: 14, borderColor: "rgba(109,181,240,0.3)" }}>
                    <div className="row between" style={{ marginBottom: 6 }}>
                      <strong style={{ fontSize: 13, color: "var(--info)" }}>Contact form only — human send</strong>
                      <Badge kind="info">HITL</Badge>
                    </div>
                    <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                      No public email — this creator prefers their contact form. Open it and paste the draft below.
                      We don't auto-submit forms (deliverability + compliance).
                    </p>
                    <div className="row gap-8" style={{ marginBottom: 10 }}>
                      {(selected.evidence.contactFormUrl ?? selected.siteUrl) && (
                        <a className="btn sm" href={selected.evidence.contactFormUrl ?? selected.siteUrl ?? "#"} target="_blank" rel="noreferrer">Open contact form ↗</a>
                      )}
                      <button className="btn sm primary" onClick={() => loadDraft(selected)}>Generate message</button>
                    </div>
                    {draft && (
                      <div>
                        <div className="faint mono" style={{ fontSize: 11, marginBottom: 4 }}>Subject: {draft.subject}</div>
                        <textarea
                          readOnly
                          value={draft.body}
                          onFocus={(e) => e.currentTarget.select()}
                          style={{ width: "100%", minHeight: 150, fontSize: 12.5, padding: 10, background: "var(--ink-900)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 6, fontFamily: "inherit" }}
                        />
                        <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>Click to select all, then copy into the form.</div>
                      </div>
                    )}
                  </div>
                )}

                {selected.evidence?.contactUrls?.length ? (
                  <div className="faint" style={{ fontSize: 11, marginTop: 10 }}>
                    Contact links followed: {selected.evidence.contactUrls.map((u) => u.kind.replace(/_/g, " ")).join(", ")}
                  </div>
                ) : null}
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
