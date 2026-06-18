import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, statusKind } from "../ui";
import { api, money, num } from "../api";
import { navigate } from "../router";

interface PortalStats {
  clicks: number;
  conversions: number;
  earningsCents: number;
}

interface PortalRelationship {
  id: string;
  merchantId: string;
  programId: string;
  role: string;
  status: string;
  merchantName?: string | null;
  merchant?: { name?: string | null } | null;
  programName?: string | null;
  program?: { name?: string | null } | null;
}

function merchantLabel(r: PortalRelationship): string {
  return r.merchantName ?? r.merchant?.name ?? r.merchantId;
}

function programLabel(r: PortalRelationship): string {
  return r.programName ?? r.program?.name ?? r.programId;
}

export function PortalDashboard() {
  const stats = useApi<PortalStats>(() => api.get("/portal/stats"));
  const rels = useApi<PortalRelationship[] | { items: PortalRelationship[]; total: number }>(() => api.get("/portal/relationships"));

  if (stats.loading || rels.loading) return <Spinner />;
  if (stats.error) return <ErrorBanner message={stats.error} />;
  if (rels.error) return <ErrorBanner message={rels.error} />;

  const s = stats.data ?? { clicks: 0, conversions: 0, earningsCents: 0 };
  const relations: PortalRelationship[] = Array.isArray(rels.data) ? rels.data : rels.data?.items ?? [];
  const cvr = s.clicks > 0 ? (s.conversions / s.clicks) : 0;
  const activeCount = relations.filter((r) => statusKind(r.status) === "pos").length;

  return (
    <>
      <PageHeader
        title="Your dashboard"
        crumb="AFFILIATE PORTAL"
        subtitle="Everything you've driven, in one place. Grab your links, watch the conversions land, and get paid."
        actions={
          <button className="btn primary" onClick={() => navigate("/portal/links")}>
            ⌖ Get your links
          </button>
        }
      />

      <div className="grid grid-3">
        <Stat label="Earnings" value={money(s.earningsCents)} foot={`${num(s.conversions)} conversions`} />
        <Stat label="Clicks" value={num(s.clicks)} foot="lifetime referred traffic" footClass="muted" />
        <Stat label="Conversions" value={num(s.conversions)} foot={`${(cvr * 100).toFixed(1)}% conversion rate`} footClass="muted" />
      </div>

      <div className="mt-24">
        <Card
          flush
          title={`Your programs · ${relations.length}`}
          sub="the merchants you're partnered with — and where you stand with each"
          actions={
            <button className="btn sm ghost" onClick={() => navigate("/portal/statement")}>
              View statement →
            </button>
          }
        >
          {relations.length === 0 ? (
            <EmptyState
              title="No programs yet"
              hint="Once a merchant approves you, their program shows up here with your role and status. Hang tight — your invites land here."
              action={<button className="btn primary" onClick={() => navigate("/portal/settings")}>Update your profile</button>}
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Program</th>
                  <th>Role</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {relations.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{merchantLabel(r)}</div>
                      <div className="faint mono" style={{ fontSize: 11 }}>{r.merchantId}</div>
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{programLabel(r)}</td>
                    <td><Badge kind="info">{r.role}</Badge></td>
                    <td><Badge kind={statusKind(r.status)}>{r.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid grid-3 mt-24">
        <Stat label="Active partnerships" value={num(activeCount)} small foot={`of ${num(relations.length)} programs`} footClass="muted" />
        <Stat label="Conversion rate" value={`${(cvr * 100).toFixed(1)}%`} small foot="clicks → conversions" footClass="muted" />
        <Stat label="Avg per conversion" value={money(s.conversions > 0 ? Math.round(s.earningsCents / s.conversions) : 0)} small foot="earned per sale" footClass="muted" />
      </div>

      <div className="grid grid-3 mt-24">
        <div className="card" style={{ cursor: "pointer" }} onClick={() => navigate("/portal/links")}>
          <div className="card-title">Tracking links</div>
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>Generate and copy links for any program. Every click is attributed back to you.</p>
        </div>
        <div className="card" style={{ cursor: "pointer" }} onClick={() => navigate("/portal/codes")}>
          <div className="card-title">Coupon codes</div>
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>Share your personal codes — perfect for video, audio, and IRL audiences.</p>
        </div>
        <div className="card" style={{ cursor: "pointer" }} onClick={() => navigate("/portal/payouts")}>
          <div className="card-title">Payouts</div>
          <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>Track what's pending, on hold, and paid. Set up where your money lands.</p>
        </div>
      </div>
    </>
  );
}
