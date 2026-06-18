import { api, money, pct, num } from "../api";
import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge, EmptyState } from "../ui";

interface ProgramHealth {
  activeAffiliates: number;
  producingAffiliates: number;
  percentProducing: number;
  revenueViaAffiliatesCents: number;
  clicks: number;
  conversions: number;
  epcCents: number;
  refundRate: number;
}

interface MoneyOps {
  unpaidLiabilityCents: number;
  heldBalanceCents: number;
  paidCents: number;
  failedPayoutRate: number;
  reversalCount: number;
  negativeBalanceExposureCents: number;
}

interface PerfRow {
  affiliateId: string;
  name: string;
  role: string;
  status: string;
  clicks: number;
  conversions: number;
  earningsCents: number;
  epcCents: number;
}

interface CohortRow {
  cohortMonth: string;
  affiliateAcquiredCustomers: number;
  revenueCents: number;
  orders: number;
  avgOrderValueCents: number;
}

interface Funnel {
  sourced: number;
  contacted: number;
  replied: number;
  converted: number;
  replyRate: number;
  conversionRate: number;
}

export function Reporting() {
  const health = useApi<ProgramHealth>(() => api.get("/reports/program-health"));
  const moneyOps = useApi<MoneyOps>(() => api.get("/reports/money-ops"));
  const perf = useApi<PerfRow[]>(() => api.get("/reports/affiliate-performance"));
  const cohort = useApi<CohortRow[]>(() => api.get("/reports/ltv-cohort"));
  const funnel = useApi<Funnel>(() => api.get("/reports/recruitment-funnel"));

  if (health.loading || moneyOps.loading) return <Spinner />;
  if (health.error) return <ErrorBanner message={health.error} />;
  if (moneyOps.error) return <ErrorBanner message={moneyOps.error} />;
  if (!health.data || !moneyOps.data) return null;

  const h = health.data;
  const m = moneyOps.data;
  const f = funnel.data;
  const perfRows = perf.data ?? [];
  const cohortRows = cohort.data ?? [];
  const cohortRevenue = cohortRows.reduce((s, r) => s + r.revenueCents, 0);
  const cohortCustomers = cohortRows.reduce((s, r) => s + r.affiliateAcquiredCustomers, 0);

  return (
    <>
      <PageHeader
        title="Reporting & analytics"
        crumb="PROVE THE VALUE"
        subtitle="Clicks are vanity. Revenue, retention, and lifetime value are the truth — this is where the program earns its budget."
        actions={
          <button
            className="btn primary"
            onClick={() => {
              health.reload();
              moneyOps.reload();
              perf.reload();
              cohort.reload();
              funnel.reload();
            }}
          >
            ↻ Refresh
          </button>
        }
      />

      <div className="grid grid-4">
        <Stat label="Revenue via affiliates" value={money(h.revenueViaAffiliatesCents)} foot={`${num(h.conversions)} conversions`} />
        <Stat label="Producing affiliates" value={num(h.producingAffiliates)} foot={`${pct(h.percentProducing)} of ${num(h.activeAffiliates)}`} footClass="muted" />
        <Stat label="EPC" value={money(h.epcCents)} foot={`${num(h.clicks)} clicks`} footClass="muted" />
        <Stat label="Refund rate" value={pct(h.refundRate)} foot="of affiliate revenue" footClass={h.refundRate > 0.1 ? "neg" : "muted"} />
      </div>

      <div className="grid grid-4 mt-24">
        <Stat label="Paid out" value={money(m.paidCents)} small />
        <Stat label="Unpaid liability" value={money(m.unpaidLiabilityCents)} foot={`${money(m.heldBalanceCents)} held`} footClass="muted" small />
        <Stat label="Failed payouts" value={pct(m.failedPayoutRate)} foot={`${num(m.reversalCount)} clawbacks`} footClass={m.failedPayoutRate > 0 ? "neg" : "muted"} small />
        <Stat label="Negative exposure" value={money(m.negativeBalanceExposureCents)} footClass={m.negativeBalanceExposureCents < 0 ? "neg" : "muted"} small />
      </div>

      {f && (
        <div className="grid grid-4 mt-24">
          <Stat label="Sourced" value={num(f.sourced)} small />
          <Stat label="Contacted" value={num(f.contacted)} foot={`reply ${pct(f.replyRate)}`} footClass="muted" small />
          <Stat label="Replied" value={num(f.replied)} small />
          <Stat label="Converted" value={num(f.converted)} foot={`convert ${pct(f.conversionRate)}`} footClass="pos" small />
        </div>
      )}

      <div className="mt-24">
        <Card flush title={`Affiliate performance · ${perfRows.length}`} sub="who actually drives sales — ranked by earnings contribution">
          {perf.loading ? (
            <div style={{ padding: 20 }}>
              <Spinner />
            </div>
          ) : perf.error ? (
            <div style={{ padding: 20 }}>
              <ErrorBanner message={perf.error} />
            </div>
          ) : perfRows.length === 0 ? (
            <EmptyState title="No performance data yet" hint="Once affiliates start driving clicks and conversions, their contribution shows up here." />
          ) : (
            <div style={{ maxHeight: 480, overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Affiliate</th>
                    <th>Role</th>
                    <th className="num">Clicks</th>
                    <th className="num">Conversions</th>
                    <th className="num">Earnings</th>
                    <th className="num">EPC</th>
                  </tr>
                </thead>
                <tbody>
                  {perfRows.map((r) => (
                    <tr key={r.affiliateId}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                        <div className="faint mono" style={{ fontSize: 11 }}>{r.status}</div>
                      </td>
                      <td>
                        <Badge kind="info">{r.role.replace(/_/g, " ")}</Badge>
                      </td>
                      <td className="num">{num(r.clicks)}</td>
                      <td className="num">{num(r.conversions)}</td>
                      <td className="num">{money(r.earningsCents)}</td>
                      <td className="num mono">{money(r.epcCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-24">
        <Card
          flush
          title="LTV / cohort analysis"
          sub="the proof beyond clicks: customers your affiliates brought in keep buying — this is the revenue a last-click report never sees"
        >
          {cohort.loading ? (
            <div style={{ padding: 20 }}>
              <Spinner />
            </div>
          ) : cohort.error ? (
            <div style={{ padding: 20 }}>
              <ErrorBanner message={cohort.error} />
            </div>
          ) : cohortRows.length === 0 ? (
            <EmptyState title="No cohorts yet" hint="Cohorts form as affiliate-acquired customers place orders over time. This is where program value compounds." />
          ) : (
            <>
              <div className="grid grid-3" style={{ padding: "0 20px" }}>
                <Stat label="Lifetime revenue" value={money(cohortRevenue)} foot="all cohorts" footClass="muted" small />
                <Stat label="Customers acquired" value={num(cohortCustomers)} foot="via affiliates" footClass="muted" small />
                <Stat
                  label="Blended AOV"
                  value={money(cohortRows.reduce((s, r) => s + r.orders, 0) > 0 ? Math.round(cohortRevenue / cohortRows.reduce((s, r) => s + r.orders, 0)) : 0)}
                  foot="across cohorts"
                  footClass="muted"
                  small
                />
              </div>
              <div style={{ maxHeight: 420, overflow: "auto", marginTop: 12 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Cohort month</th>
                      <th className="num">Customers</th>
                      <th className="num">Revenue</th>
                      <th className="num">Orders</th>
                      <th className="num">AOV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cohortRows.map((c) => (
                      <tr key={c.cohortMonth}>
                        <td style={{ fontWeight: 600 }}>{c.cohortMonth}</td>
                        <td className="num">{num(c.affiliateAcquiredCustomers)}</td>
                        <td className="num">{money(c.revenueCents)}</td>
                        <td className="num">{num(c.orders)}</td>
                        <td className="num mono">{money(c.avgOrderValueCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
