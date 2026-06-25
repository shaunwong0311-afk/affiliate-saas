import { useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useApi, Card, Spinner, PageHeader, Badge, EmptyState } from "../ui";

/**
 * The Niche Map — an interactive radial view of the recursive discovery frontier.
 * Seed competitors sit at the centre; each ring outward is one expansion hop. A node
 * is a merchant (sized by how many of your discovered affiliates co-promote it,
 * coloured by status); an edge links it to the merchant whose affiliates surfaced it.
 * Watch the snowball map the whole niche. Drag to pan, scroll to zoom, click a node.
 */

interface FrontierNode {
  id: string;
  domain: string;
  label: string;
  depth: number;
  coPromotions: number;
  status: "pending" | "mined" | "skipped";
  source: "seed" | "expansion";
  discoveredFrom: string | null;
}
interface FrontierData {
  nodes: FrontierNode[];
  prospectsByDomain: Record<string, number>;
}

const STATUS_COLOR: Record<string, string> = {
  pending: "var(--warn)",
  mined: "var(--acc)",
  skipped: "var(--text-dim)",
};
const RING = 165;

export function NicheMap() {
  const frontier = useApi<FrontierData>(() => api.get("/recruitment/frontier"));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<FrontierNode | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const nodes = frontier.data?.nodes ?? [];
  const prospects = frontier.data?.prospectsByDomain ?? {};

  // Radial layout: group by depth, spread each depth around its ring.
  const positions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    const byDepth = new Map<number, FrontierNode[]>();
    for (const n of nodes) (byDepth.get(n.depth) ?? byDepth.set(n.depth, []).get(n.depth)!).push(n);
    for (const [depth, group] of byDepth) {
      const r = depth === 0 ? (group.length > 1 ? 80 : 0) : 110 + (depth - 1) * RING;
      group.forEach((n, i) => {
        const angle = (i / Math.max(1, group.length)) * Math.PI * 2 - Math.PI / 2;
        pos.set(n.id, { x: Math.cos(angle) * r, y: Math.sin(angle) * r });
      });
    }
    return pos;
  }, [nodes]);

  const byDomain = useMemo(() => new Map(nodes.map((n) => [n.domain, n])), [nodes]);
  const maxDepth = nodes.reduce((m, n) => Math.max(m, n.depth), 0);

  async function expand() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ mined: string[]; discovered: number; promoted: { domain: string }[]; frontierPending: number }>(
        "/recruitment/frontier/expand",
        { maxSeedsPerCycle: 3 },
      );
      setMsg(`Mined ${r.mined.length} → discovered ${r.discovered} affiliates → promoted ${r.promoted.length} new competitor(s). ${r.frontierPending} pending.`);
      frontier.reload();
    } catch (e: any) {
      setMsg(e?.message ?? "expansion failed");
    } finally {
      setBusy(false);
    }
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    setView((v) => ({ ...v, k: Math.min(3, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.12 : 0.89))) }));
  }
  function onDown(e: React.MouseEvent) {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  }
  function onMove(e: React.MouseEvent) {
    if (!drag.current) return;
    setView((v) => ({ ...v, x: drag.current!.vx + (e.clientX - drag.current!.x), y: drag.current!.vy + (e.clientY - drag.current!.y) }));
  }
  const endDrag = () => (drag.current = null);

  if (frontier.loading) return <Spinner />;

  const seeds = nodes.filter((n) => n.source === "seed").length;
  const discovered = nodes.filter((n) => n.source === "expansion").length;

  return (
    <>
      <PageHeader
        title="Niche Map"
        crumb="RECURSIVE DISCOVERY"
        subtitle="The frontier snowball: seed competitors at the centre, each ring one expansion hop outward. We mine a competitor's affiliates, read who else they promote, and the frequently co-promoted merchants become the next seeds."
        actions={
          <button className="btn primary" onClick={expand} disabled={busy}>
            {busy ? "expanding…" : "⊕ Run expansion"}
          </button>
        }
      />

      {msg && <div className="err-banner" style={{ background: "var(--acc-glow)", borderColor: "var(--acc-dim)", color: "var(--acc)" }}>{msg}</div>}

      <div className="row gap-8" style={{ marginBottom: 16 }}>
        <Badge kind="info">{seeds} seed{seeds === 1 ? "" : "s"}</Badge>
        <Badge kind="pos">{discovered} discovered</Badge>
        <Badge>depth {maxDepth}</Badge>
        <span className="faint" style={{ fontSize: 11, alignSelf: "center" }}>drag to pan · scroll to zoom · click a node</span>
      </div>

      {nodes.length === 0 ? (
        <EmptyState
          title="The frontier is empty"
          hint="Set competitors in the Recruitment ICP and run sourcing or expansion — the seeds appear here and the map grows outward as the engine mines the niche."
          action={<button className="btn primary" onClick={expand} disabled={busy}>Run expansion</button>}
        />
      ) : (
        <div className="grid" style={{ gridTemplateColumns: selected ? "1fr 300px" : "1fr", gap: 16 }}>
          <Card flush>
            <svg
              viewBox="0 0 900 600"
              style={{ width: "100%", height: 560, display: "block", background: "radial-gradient(circle at 50% 45%, var(--ink-850), var(--ink-900) 70%)", cursor: drag.current ? "grabbing" : "grab", borderRadius: 10 }}
              onWheel={onWheel}
              onMouseDown={onDown}
              onMouseMove={onMove}
              onMouseUp={endDrag}
              onMouseLeave={endDrag}
            >
              <defs>
                <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feGaussianBlur stdDeviation="3.5" result="b" />
                  <feMerge>
                    <feMergeNode in="b" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              <g transform={`translate(${450 + view.x},${300 + view.y}) scale(${view.k})`}>
                {/* depth rings */}
                {Array.from({ length: maxDepth }, (_, d) => (
                  <circle key={d} cx={0} cy={0} r={110 + d * RING} fill="none" stroke="var(--line)" strokeDasharray="3 6" opacity={0.4} />
                ))}
                {/* edges */}
                {nodes.map((n) => {
                  const parent = n.discoveredFrom ? byDomain.get(n.discoveredFrom) : null;
                  if (!parent) return null;
                  const a = positions.get(parent.id);
                  const b = positions.get(n.id);
                  if (!a || !b) return null;
                  const lit = hover === n.id || hover === parent.id || selected?.id === n.id || selected?.id === parent.id;
                  return <line key={`e-${n.id}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={lit ? "var(--acc)" : "var(--line)"} strokeWidth={lit ? 1.6 : 0.8} opacity={lit ? 0.9 : 0.5} />;
                })}
                {/* nodes */}
                {nodes.map((n) => {
                  const p = positions.get(n.id);
                  if (!p) return null;
                  const r = (n.source === "seed" ? 15 : 9) + Math.min(10, n.coPromotions) * 1.6;
                  const color = STATUS_COLOR[n.status] ?? "var(--text-dim)";
                  const active = hover === n.id || selected?.id === n.id;
                  return (
                    <g key={n.id} transform={`translate(${p.x},${p.y})`} style={{ cursor: "pointer" }}
                      onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => setSelected(n)}>
                      <circle r={r} fill={color} fillOpacity={n.status === "skipped" ? 0.25 : 0.85} filter={active ? "url(#glow)" : undefined} stroke={active ? "#fff" : color} strokeWidth={active ? 1.5 : 0} />
                      {n.status === "pending" && <circle r={r} fill="none" stroke={color} strokeWidth={1}><animate attributeName="r" values={`${r};${r + 7};${r}`} dur="2.2s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.7;0;0.7" dur="2.2s" repeatCount="indefinite" /></circle>}
                      <text y={r + 13} textAnchor="middle" fontSize={11} fill={active ? "var(--text)" : "var(--text-dim)"} style={{ pointerEvents: "none", fontWeight: n.source === "seed" ? 700 : 400 }}>
                        {n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
            <div className="row gap-8" style={{ padding: "10px 14px", flexWrap: "wrap" }}>
              <Legend color="var(--warn)" label="pending (queued to mine)" />
              <Legend color="var(--acc)" label="mined" />
              <Legend color="var(--text-dim)" label="skipped" />
              <span className="faint" style={{ fontSize: 11 }}>· node size = how many affiliates co-promote it</span>
            </div>
          </Card>

          {selected && (
            <Card title={selected.label} sub={`depth ${selected.depth} · ${selected.source}`}>
              <div className="row gap-8" style={{ marginBottom: 12 }}>
                <Badge kind={selected.status === "mined" ? "pos" : selected.status === "pending" ? "warn" : ""}>{selected.status}</Badge>
                {selected.coPromotions > 0 && <Badge kind="info">{selected.coPromotions} co-promotions</Badge>}
              </div>
              <Row k="Affiliates found" v={String(prospects[selected.domain] ?? 0)} />
              <Row k="Surfaced from" v={selected.discoveredFrom ?? "— (seed competitor)"} />
              <Row k="Domain" v={selected.domain} mono />
              <div className="faint" style={{ fontSize: 11.5, marginTop: 12 }}>
                {selected.status === "pending"
                  ? "Queued — the next expansion cycle will backlink-mine this merchant for its affiliates."
                  : selected.status === "mined"
                    ? "Mined — its affiliates were ingested, and the merchants they also promote became new map nodes."
                    : "Skipped."}
              </div>
              <a className="btn sm ghost mt-16" href="#/recruitment">View prospects →</a>
            </Card>
          )}
        </div>
      )}
    </>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="row gap-8" style={{ fontSize: 11.5, alignItems: "center" }}>
      <span style={{ width: 10, height: 10, borderRadius: 99, background: color, display: "inline-block" }} /> {label}
    </span>
  );
}
function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="row between" style={{ marginBottom: 7 }}>
      <span className="muted" style={{ fontSize: 12.5 }}>{k}</span>
      <span className={mono ? "mono" : ""} style={{ fontSize: 12.5 }}>{v}</span>
    </div>
  );
}
