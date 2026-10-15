import { useRef, useState } from "react";
import { api, errorMessage, num } from "../api";
import { useApi, Card, Spinner, ErrorBanner, Notice, PageHeader, Badge, EmptyState, humanize, safeHref } from "../ui";
import { Link } from "../router";
import { BulkImport } from "../BulkImport";

// `Prospect.evidence` is free-form JSON written by several pipeline stages over time, so
// every part of it is optional here and read through a fallback — older prospects simply
// do not carry the newer keys.
interface Account {
  platform?: string | null;
  handle?: string | null;
  url?: string | null;
  provenance?: string | null;
  confidence?: number | null;
}
interface Profile {
  primary?: Account | null;
  accounts?: Account[] | null;
  audience?: { reach?: number | null; primaryGeo?: string | null; language?: string | null; engagementRate?: number | null; source?: string | null } | null;
  identityConfidence?: number | null;
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
  source?: string | null;
  siteUrl?: string | null;
  channelUrl?: string | null;
  email?: string | null;
  state: string;
  score?: number | null;
  tier?: "A" | "B" | "C" | null;
  synthetic?: boolean;
  confidence?: number | null;
  evidence?: Evidence | null;
  scoreBreakdown?: { explanation?: string[]; breakdown?: { factor: string; contribution?: number | null; note?: string }[]; unknownFactors?: string[] } | null;
}

interface OutreachMessage {
  id: string;
  step: number;
  variant?: string | null;
  subject?: string;
  sentAt?: string | null;
  status: string; // queued | sent | bounced | replied | failed
}
interface Reply {
  id: string;
  classification?: string | null; // interested | question | not_interested | out_of_office | unsubscribe | unknown
  ts: string;
}

interface SourcingResult {
  discovered?: number;
  scored?: number;
  byTier?: Record<string, number> | null;
  real?: number;
  synthetic?: number;
}

/** Queue filter → the `state` query the prospects route accepts ("" = every state). */
const STATE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "all states" },
  { value: "discovered", label: "new — not yet scored" },
  { value: "scored", label: "scored" },
  { value: "contacted", label: "contacted" },
  { value: "in_sequence", label: "in sequence" },
  { value: "replied", label: "replied" },
  { value: "converted", label: "converted" },
];

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
function platformIcon(platform: string | null | undefined): string {
  return (platform && PLATFORM_ICONS[platform]) || "•";
}
function fmtReach(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export function Recruitment() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Prospect | null>(null);
  const [draft, setDraft] = useState<{ subject?: string; body?: string; formUrl?: string | null } | null>(null);
  const [activity, setActivity] = useState<{ messages: OutreachMessage[]; replies: Reply[] } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [stateFilter, setStateFilter] = useState("");
  // The prospect whose history is being loaded — see select().
  const selectedId = useRef<string | null>(null);
  const prospects = useApi<{ items?: Prospect[]; total?: number } | null>(
    () => api.get(`/recruitment/prospects?limit=100${stateFilter ? `&state=${encodeURIComponent(stateFilter)}` : ""}`),
    [stateFilter],
  );
  const icp = useApi<{ niche?: string | null; competitors?: string[] | null } | null>(() => api.get("/recruitment/icp"));

  function ok(text: string) {
    setMsg(text);
    setErr(null);
  }
  function fail(e: unknown, fallback: string) {
    setErr(errorMessage(e, fallback));
    setMsg(null);
  }

  async function source() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const res = (await api.post<SourcingResult | null>("/recruitment/source", { limit: 12 })) ?? {};
      const byTier = res.byTier ?? {};
      const demoNote = (res.synthetic ?? 0) > 0 ? ` · ${res.real ?? 0} real, ${res.synthetic} demo` : "";
      ok(`Sourced ${res.discovered ?? 0}, scored ${res.scored ?? 0} — A:${byTier.A ?? 0} B:${byTier.B ?? 0} C:${byTier.C ?? 0}${demoNote}`);
      prospects.reload();
    } catch (e) {
      fail(e, "Sourcing failed.");
    } finally {
      setBusy(false);
    }
  }

  async function approve(p: Prospect) {
    try {
      await api.post(`/recruitment/prospects/${p.id}/approve`, {});
      prospects.reload();
      setSelected(null);
    } catch (e) {
      fail(e, "Approve failed.");
    }
  }

  async function reject(p: Prospect) {
    try {
      await api.post(`/recruitment/prospects/${p.id}/reject`, {});
      prospects.reload();
      setSelected(null);
    } catch (e) {
      fail(e, "Reject failed.");
    }
  }

  function select(p: Prospect) {
    setSelected(p);
    selectedId.current = p.id;
    setDraft(null); // clear any stale contact-form draft
    setActivity(null);
    // Pull the full outreach history (touches + replies) for the timeline. A fast second
    // click must not let the first prospect's (slower) answer overwrite the second's.
    api
      .get<{ messages?: OutreachMessage[]; replies?: Reply[] } | null>(`/recruitment/prospects/${p.id}`)
      .then((d) => ({ messages: d?.messages ?? [], replies: d?.replies ?? [] }))
      .catch(() => ({ messages: [] as OutreachMessage[], replies: [] as Reply[] }))
      .then((next) => {
        if (selectedId.current === p.id) setActivity(next);
      });
  }

  async function loadDraft(p: Prospect) {
    try {
      const d = await api.get<{ subject?: string; body?: string; formUrl?: string | null } | null>(`/recruitment/prospects/${p.id}/contact-draft`);
      setDraft(d ?? {});
    } catch (e) {
      fail(e, "Could not load the draft.");
    }
  }

  if (prospects.loading && !prospects.data) return <Spinner />;
  const items = prospects.data?.items ?? [];
  const total = prospects.data?.total ?? items.length;
  const syntheticCount = items.filter((p) => p.synthetic).length;
  const competitors = icp.data?.competitors ?? [];
  const profile = selected?.evidence?.profile ?? null;
  const accounts = profile?.accounts ?? [];

  return (
    <>
      <PageHeader
        title="Recruitment engine"
        crumb="THE WEDGE"
        subtitle="Targeting is the moat, sending is the mechanism. We find who already promotes your competitors — proven affiliates in your exact niche — and score them for who will actually drive sales."
        actions={
          <>
            <button className="btn" onClick={() => setImportOpen((v) => !v)}>
              {importOpen ? "Close import" : "⇪ Import prospects"}
            </button>
            <button className="btn primary" onClick={source} disabled={busy}>
              {busy ? "sourcing…" : "⌖ Run sourcing"}
            </button>
          </>
        }
      />

      {importOpen && (
        <BulkImport
          kind="prospects"
          onClose={() => setImportOpen(false)}
          onImported={(summary) => {
            // New prospects are unscored, so they sit below the top-100-by-score the queue
            // normally shows. Switch to the "new" view so the import is visible — unless
            // everything in the file was already known, in which case just refresh.
            if ((summary.counts.imported ?? 0) > 0 && stateFilter !== "discovered") setStateFilter("discovered");
            else prospects.reload();
          }}
          onEnriched={() => {
            // They are scored now and have left the "new" view — show the ranked queue.
            if (stateFilter) setStateFilter("");
            else prospects.reload();
          }}
        />
      )}

      {err && <ErrorBanner message={err} />}
      {msg && <Notice kind="ok">{msg}</Notice>}
      {prospects.error && <ErrorBanner message={prospects.error} />}
      {syntheticCount > 0 && (
        <div
          className="err-banner"
          style={{ background: "rgba(245, 180, 60, 0.10)", borderColor: "rgba(245, 180, 60, 0.45)", color: "#f5b43c", marginBottom: 14 }}
        >
          ⚠ {syntheticCount} of {items.length} prospects are <strong>demo data</strong> from deterministic generators (no SERP/email keys wired). Sourced/verified/tier counts that include them are illustrative, not real affiliates. Set <span className="mono">SERPAPI_KEY</span> + <span className="mono">HUNTER_API_KEY</span> for live discovery.
        </div>
      )}
      <div className="row wrap gap-8" style={{ marginBottom: 18 }}>
        {icp.data && (
          <>
            <Badge>niche: {icp.data.niche ?? "unset"}</Badge>
            {competitors.length ? competitors.map((c) => <Badge key={c} kind="info">vs {c}</Badge>) : <Badge kind="warn">no competitors set</Badge>}
            <Link to="/settings" className="faint">
              <span style={{ fontSize: 12, textDecoration: "underline" }}>edit in Settings</span>
            </Link>
          </>
        )}
        <span className="spacer" />
        <select className="select" value={stateFilter} onChange={(e) => { setStateFilter(e.target.value); setSelected(null); }} style={{ width: "auto", minWidth: 190 }} aria-label="Filter prospects by state">
          {STATE_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {items.length === 0 ? (
        stateFilter ? (
          <EmptyState
            title="No prospects in this state"
            hint={`Nothing is "${humanize(stateFilter)}" right now.`}
            action={<button className="btn ghost" onClick={() => setStateFilter("")}>Show all states</button>}
          />
        ) : (
          <EmptyState
            title="No prospects yet"
            hint="Run sourcing to mine competitor affiliates, creators, and customers — or import a list you already have. Competitor-affiliate mining is the highest-signal source."
            action={
              <div className="row gap-8" style={{ justifyContent: "center" }}>
                <button className="btn primary" onClick={source} disabled={busy}>Run sourcing</button>
                <button className="btn" onClick={() => setImportOpen(true)}>Import a list</button>
              </div>
            }
          />
        )
      ) : (
        // Dimmed while a different filter is loading, so the old rows do not read as the answer.
        <div className="grid grid-2" style={{ opacity: prospects.loading ? 0.6 : 1, transition: "opacity .15s" }}>
          <Card
            flush
            title={`Prospect queue · ${num(items.length)}${total > items.length ? ` of ${num(total)}` : ""}`}
            sub={total > items.length ? "the top 100 by fit + propensity score — filter by state to see the rest" : "ranked by fit + propensity score"}
          >
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
                      <td className="muted" style={{ fontSize: 12 }}>{humanize(p.source)}</td>
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
                          ts: r.ts ?? "",
                          label: `Reply · ${humanize(r.classification, "unclassified")}`,
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

                {(selected.scoreBreakdown?.breakdown ?? []).map((b) => {
                  const contribution = typeof b.contribution === "number" ? b.contribution : 0;
                  if (contribution <= 0) return null;
                  return (
                    <div className="factor-row" key={b.factor}>
                      <span className="muted" style={{ fontSize: 12.5 }}>{b.factor}</span>
                      <div className="scorebar">
                        <span style={{ width: `${Math.min(100, contribution * 3)}%` }} />
                      </div>
                      <span className="mono num" style={{ fontSize: 12 }}>+{contribution.toFixed(1)}</span>
                    </div>
                  );
                })}

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
                        Found on:{" "}
                        {safeHref(selected.evidence.pageUrl) ? (
                          <a href={safeHref(selected.evidence.pageUrl)} target="_blank" rel="noreferrer" className="mono" style={{ color: "var(--acc)" }}>{selected.evidence.pageUrl}</a>
                        ) : (
                          <span className="mono">{selected.evidence.pageUrl}</span>
                        )}
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

                {profile && accounts.length > 1 && (
                  <div className="card" style={{ background: "var(--ink-850)", marginTop: 12, padding: 14 }}>
                    <div className="row between" style={{ marginBottom: 8 }}>
                      <span className="faint" style={{ fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase" }}>Identity graph</span>
                      {typeof profile.identityConfidence === "number" && (
                        <span className="faint" style={{ fontSize: 11 }}>{Math.round(profile.identityConfidence * 100)}% linked</span>
                      )}
                    </div>
                    <div className="row wrap gap-8">
                      {accounts.map((a, i) => {
                        const confidence = typeof a.confidence === "number" ? a.confidence : null;
                        const badge = (
                          <Badge kind={a.provenance === "seed" ? "info" : confidence != null && confidence >= 0.85 ? "pos" : ""}>
                            {platformIcon(a.platform)} {a.handle ?? a.platform ?? "account"}
                          </Badge>
                        );
                        const title = `${humanize(a.provenance, "source unknown")}${confidence != null ? ` · ${Math.round(confidence * 100)}% confidence` : ""}`;
                        const href = safeHref(a.url);
                        // Scraped URL: only a plain http(s) address becomes a link.
                        return href ? (
                          <a key={i} href={href} target="_blank" rel="noreferrer" title={title} style={{ textDecoration: "none" }}>
                            {badge}
                          </a>
                        ) : (
                          <span key={i} title={title}>{badge}</span>
                        );
                      })}
                    </div>
                    {(() => {
                      const a = profile.audience;
                      const has = a && (a.reach != null || a.engagementRate != null || a.primaryGeo);
                      return has ? (
                        <div className="row wrap gap-8" style={{ marginTop: 10 }}>
                          {a.reach != null && <Badge kind="pos">{fmtReach(a.reach)} reach</Badge>}
                          {a.engagementRate != null && <Badge kind="info">{(a.engagementRate * 100).toFixed(1)}% engagement</Badge>}
                          {a.primaryGeo && <Badge>{a.primaryGeo}</Badge>}
                          {a.source && <span className="faint" style={{ fontSize: 10.5, alignSelf: "center" }}>via {a.source}</span>}
                        </div>
                      ) : null;
                    })()}
                    <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>
                      Surfaces this creator owns, unified from the links they published. Reach + engagement fill in per platform (free on YouTube); audience demographics need a provider.
                    </div>
                  </div>
                )}

                <div className="row gap-8 mt-16">
                  <button className="btn primary sm" onClick={() => approve(selected)} disabled={!selected.email}>
                    Approve → create affiliate
                  </button>
                  <button className="btn sm ghost" onClick={() => reject(selected)}>
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
                      {safeHref(selected.evidence.contactFormUrl ?? selected.siteUrl) && (
                        <a className="btn sm" href={safeHref(selected.evidence.contactFormUrl ?? selected.siteUrl)} target="_blank" rel="noreferrer">Open contact form ↗</a>
                      )}
                      <button className="btn sm primary" onClick={() => loadDraft(selected)}>Generate message</button>
                    </div>
                    {draft && (
                      <div>
                        <div className="faint mono" style={{ fontSize: 11, marginBottom: 4 }}>Subject: {draft.subject ?? ""}</div>
                        <textarea
                          readOnly
                          value={draft.body ?? ""}
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
                    Contact links followed: {selected.evidence.contactUrls.map((u) => humanize(u?.kind, "link")).join(", ")}
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
