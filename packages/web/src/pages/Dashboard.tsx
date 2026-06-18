import { api, money, pct, num } from "../api";
import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge } from "../ui";
import { navigate } from "../router";

interface Overview {
  health: { activeAffiliates: number; producingAffiliates: number; percentProducing: number; revenueViaAffiliatesCents: number; clicks: number; conversions: number; epcCents: number; refundRate: number };
  money: { unpaidLiabilityCents: number; heldBalanceCents: number; paidCents: number; failedPayoutRate: number; reversalCount: number; negativeBalanceExposureCents: number };
  funnel: { sourced: number; contacted: number; replied: number; converted: number; replyRate: number; conversionRate: number; byTier: Record<string, number> };
}

export function Dashboard() {
  const { data, loading, error } = useApi<Overview>(() => api.get("/reports/overview"));
  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return null;
  const { health, money: m, funnel } = data;

  const funnelSteps = [
    { label: "Sourced", value: funnel.sourced },
    { label: "Contacted", value: funnel.contacted },
    { label: "Replied", value: funnel.replied },
    { label: "Converted", value: funnel.converted },
  ];
  const maxF = Math.max(1, ...funnelSteps.map((s) => s.value));

  return (
    <>
      <PageHeader
        title="Command center"
        crumb="OVERVIEW"
        subtitle="Tracking is the floor. The number that matters is producing affiliates — and where your next ones come from."
        actions={
          <button className="btn primary" onClick={() => navigate("/recruitment")}>
            ⌖ Find affiliates
          </button>
        }
      />

      <div className="grid grid-4">
        <Stat label="Revenue via affiliates" value={money(health.revenueViaAffiliatesCents)} foot={`${num(health.conversions)} conversions`} />
        <Stat label="Producing affiliates" value={num(health.producingAffiliates)} foot={`${pct(health.percentProducing)} of roster`} footClass="muted" />
        <Stat label="Unpaid liability" value={money(m.unpaidLiabilityCents)} foot={`${money(m.heldBalanceCents)} on hold`} footClass="muted" />
        <Stat label="EPC" value={money(health.epcCents)} foot={`${num(health.clicks)} clicks`} footClass="muted" />
      </div>

      <div className="grid grid-2 mt-24">
        <Card title="Recruitment funnel" sub="sourced → contacted → replied → converted">
          <div className="mt-16">
            {funnelSteps.map((s) => (
              <div className="funnel-step" key={s.label}>
                <span className="muted">{s.label}</span>
                <div className="funnel-bar" style={{ width: `${(s.value / maxF) * 100}%` }}>
                  {s.value}
                </div>
                <span />
              </div>
            ))}
          </div>
          <div className="row gap-8 mt-16">
            <Badge kind="info">reply {pct(funnel.replyRate)}</Badge>
            <Badge kind="pos">convert {pct(funnel.conversionRate)}</Badge>
            {Object.entries(funnel.byTier).map(([t, c]) => (
              <Badge key={t} kind={`tier-${t}`}>
                {t}: {c}
              </Badge>
            ))}
          </div>
        </Card>

        <Card title="Money operations" sub="trust is won or lost after commissions are calculated">
          <div className="grid grid-2 mt-16">
            <Stat small label="Paid out" value={money(m.paidCents)} />
            <Stat small label="Failed payouts" value={pct(m.failedPayoutRate)} footClass={m.failedPayoutRate > 0 ? "neg" : "muted"} />
            <Stat small label="Clawbacks" value={num(m.reversalCount)} foot="reversals" footClass="muted" />
            <Stat small label="Negative exposure" value={money(m.negativeBalanceExposureCents)} footClass={m.negativeBalanceExposureCents < 0 ? "neg" : "muted"} />
          </div>
          <div className="row gap-8 mt-16">
            <button className="btn sm" onClick={() => navigate("/payouts")}>
              Payout console →
            </button>
            <button className="btn sm ghost" onClick={() => navigate("/conversions")}>
              Review queue
            </button>
          </div>
        </Card>
      </div>

      <div className="grid grid-3 mt-24">
        <Stat label="Active affiliates" value={num(health.activeAffiliates)} small />
        <Stat label="Refund rate" value={pct(health.refundRate)} small footClass={health.refundRate > 0.1 ? "neg" : "muted"} />
        <Stat label="Conversions" value={num(health.conversions)} small />
      </div>
    </>
  );
}
