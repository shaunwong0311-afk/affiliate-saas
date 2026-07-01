import { api, pct, num } from "../api";
import { useApi, Card, Stat, Badge, PageHeader, EmptyState } from "../ui";

interface Recruit {
  affiliateId: string;
  relationshipId: string;
  joinedAt: string;
  daysToFirstClick: number | null;
  daysToFirstSale: number | null;
  status: "producing" | "activated" | "recruited";
  fastStart: "earned" | "in_window" | "missed";
}
interface ActivationMetrics {
  recruited: number;
  activated: number;
  producing: number;
  activationRate: number;
  producingRate: number;
  fastStartEarned: number;
  fastStartInWindow: number;
  medianDaysToFirstClick: number | null;
  medianDaysToFirstSale: number | null;
  recruits: Recruit[];
}
interface Campaign { id: string; name: string; status: string }
interface AbRow { variant: string; sent: number; replied: number; replyRate: number }

/** A horizontal funnel bar (value relative to the top of the funnel). */
function FunnelBar({ label, value, of, kind }: { label: string; value: number; of: number; kind: string }) {
  const w = of > 0 ? (value / of) * 100 : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 13 }}>{label}</span>
        <span className="mono" style={{ fontSize: 13 }}>{num(value)} <span className="faint">· {pct(of ? value / of : 0)}</span></span>
      </div>
      <div style={{ height: 10, background: "var(--ink-850)", borderRadius: 999, overflow: "hidden" }}>
        <div style={{ width: `${Math.max(2, w)}%`, height: "100%", background: `var(--${kind})`, transition: "width .4s" }} />
      </div>
    </div>
  );
}

export function Activation() {
  const m = useApi<ActivationMetrics>(() => api.get("/recruitment/activation"));
  const campaigns = useApi<Campaign[]>(() => api.get("/recruitment/campaigns"));
  const active = (campaigns.data ?? []).find((c) => c.status === "active") ?? (campaigns.data ?? [])[0] ?? null;
  const ab = useApi<AbRow[]>(() => (active ? api.get(`/recruitment/campaigns/${active.id}/ab`) : Promise.resolve([])), [active?.id]);

  if (m.loading) return null;
  if (m.error) return <div className="err-banner">{m.error}</div>;
  const d = m.data;
  const bestAb = (ab.data ?? []).slice().sort((a, b) => b.replyRate - a.replyRate)[0];

  return (
    <>
      <PageHeader
        title="Activation"
        crumb="RECRUITMENT ROI · DID THEY ACTUALLY SELL?"
        subtitle="Signing an affiliate is worthless if they never share a link. This is the funnel from recruited → first click → first sale, plus fast-start (first sale inside the 14-day window) — the metric that separates a real program from a vanity roster."
      />

      <div className="grid grid-4">
        <Stat label="Activation rate" value={d ? pct(d.activationRate) : "—"} foot="recruited → drove a click" footClass="muted" small />
        <Stat label="Producing rate" value={d ? pct(d.producingRate) : "—"} foot="recruited → drove a sale" footClass="muted" small />
        <Stat label="Median days → 1st sale" value={d?.medianDaysToFirstSale != null ? d.medianDaysToFirstSale.toFixed(1) : "—"} foot="speed to revenue" footClass="muted" small />
        <Stat label="Fast-start earned" value={d ? num(d.fastStartEarned) : "—"} foot={d ? `${num(d.fastStartInWindow)} still in window` : ""} footClass="muted" small />
      </div>

      <div className="grid grid-2 mt-24">
        <Card title="Activation funnel" sub="where recruits drop off">
          {!d || d.recruited === 0 ? (
            <div className="mt-16"><EmptyState title="No recruits yet" hint="Convert a prospect or approve an applicant to start the funnel." /></div>
          ) : (
            <div className="mt-16">
              <FunnelBar label="Recruited" value={d.recruited} of={d.recruited} kind="acc" />
              <FunnelBar label="Activated (first click)" value={d.activated} of={d.recruited} kind="acc" />
              <FunnelBar label="Producing (first sale)" value={d.producing} of={d.recruited} kind="acc" />
            </div>
          )}
        </Card>

        <Card flush title="A/B — subject variants" sub={active ? `campaign: ${active.name}` : "no campaign yet"}>
          {!ab.data || ab.data.length === 0 ? (
            <div style={{ padding: 20 }}><EmptyState title="No A/B data yet" hint="Add step variants (ab:*) and send a few to compare reply rates." /></div>
          ) : (
            <table className="table">
              <thead><tr><th>Variant</th><th className="num">Sent</th><th className="num">Replied</th><th className="num">Reply rate</th></tr></thead>
              <tbody>
                {ab.data.map((r) => (
                  <tr key={r.variant}>
                    <td className="mono" style={{ fontSize: 12 }}>{r.variant.replace(/^ab:/, "")}{bestAb?.variant === r.variant && r.sent > 0 ? " ★" : ""}</td>
                    <td className="num">{r.sent}</td>
                    <td className="num">{r.replied}</td>
                    <td className="num"><Badge kind={bestAb?.variant === r.variant && r.sent > 0 ? "pos" : ""}>{pct(r.replyRate)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="mt-24">
        <Card flush title="Recruits" sub="every affiliate traced back to the recruitment funnel">
          {!d || d.recruits.length === 0 ? (
            <div style={{ padding: 20 }}><EmptyState title="No recruits yet" /></div>
          ) : (
            <table className="table">
              <thead><tr><th>Affiliate</th><th>Status</th><th>Fast-start</th><th className="num">Days → click</th><th className="num">Days → sale</th></tr></thead>
              <tbody>
                {d.recruits.map((r) => (
                  <tr key={r.relationshipId}>
                    <td className="mono" style={{ fontSize: 12 }}>{r.affiliateId.slice(-8)}</td>
                    <td><Badge kind={r.status === "producing" ? "pos" : r.status === "activated" ? "info" : ""}>{r.status}</Badge></td>
                    <td><Badge kind={r.fastStart === "earned" ? "pos" : r.fastStart === "in_window" ? "warn" : ""}>{r.fastStart.replace(/_/g, " ")}</Badge></td>
                    <td className="num">{r.daysToFirstClick != null ? r.daysToFirstClick.toFixed(1) : "—"}</td>
                    <td className="num">{r.daysToFirstSale != null ? r.daysToFirstSale.toFixed(1) : "—"}</td>
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
