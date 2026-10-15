import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, statusKind, humanize } from "../ui";
import { api, money, num, shortDate } from "../api";
import { navigate } from "../router";

/** `GET /portal/payouts` — the affiliate's own payouts, across every merchant they work with. */
interface Payout {
  id?: string;
  amountCents: number;
  currency: string;
  method?: string | null;
  /** pending | awaiting_payment | processing | paid | failed | held */
  status: string;
  ts?: string | null;
}

/**
 * What a payout status means to the person being paid. Merchants pay affiliates directly
 * from their own account, so "awaiting payment" is the merchant's step, not a delay here.
 */
function statusLabel(status: string): string {
  switch (status) {
    case "awaiting_payment":
      return "approved — merchant is paying";
    case "pending":
      return "in a batch — awaiting approval";
    default:
      return humanize(status);
  }
}

export function PortalPayouts() {
  const { data, loading, error } = useApi<Payout[] | null>(() => api.get("/portal/payouts"));

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;

  const payouts = data ?? [];
  const currency = payouts[0]?.currency ?? "USD";
  // Headline figures are in one currency; payouts in another are counted, not summed in.
  const inCurrency = payouts.filter((p) => p.currency === currency);
  const paid = inCurrency.filter((p) => statusKind(p.status) === "pos");
  const inFlight = inCurrency.filter((p) => statusKind(p.status) === "warn");
  const paidCents = paid.reduce((sum, p) => sum + p.amountCents, 0);
  const pendingCents = inFlight.reduce((sum, p) => sum + p.amountCents, 0);
  const otherCurrencies = payouts.length - inCurrency.length;

  return (
    <>
      <PageHeader
        title="Payouts"
        crumb="PORTAL"
        subtitle="Every payout, from approved to landed. Each merchant pays you directly from their own account, to the payout details you've saved — Vantage keeps the record, it never holds your money."
        actions={
          <button className="btn primary" onClick={() => navigate("/portal/settings")}>
            ⌖ Payout settings
          </button>
        }
      />

      <div
        className="notice ok"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
      >
        <span>
          A merchant can only pay you once a tax form is on file, your payout details are saved, and your balance clears their minimum. Until then
          earnings keep accruing.
        </span>
        <button className="btn sm" style={{ flex: "0 0 auto" }} onClick={() => navigate("/portal/settings")}>
          Payout &amp; tax setup →
        </button>
      </div>

      <div className="grid grid-3" style={{ marginTop: 18 }}>
        <Stat label="Paid out" value={money(paidCents, currency)} foot={`${num(paid.length)} settled`} footClass="muted" />
        <Stat label="On its way" value={money(pendingCents, currency)} foot="approved or in a batch" footClass={pendingCents > 0 ? "warn" : "muted"} />
        <Stat
          label="Payouts"
          value={num(payouts.length)}
          foot={otherCurrencies > 0 ? `${num(otherCurrencies)} in other currencies` : "lifetime transactions"}
          footClass="muted"
        />
      </div>

      <div className="mt-24">
        {payouts.length === 0 ? (
          <EmptyState
            title="No payouts yet"
            hint="Once your balance clears a merchant's minimum and your tax form and payout details are on file, they include you in their next payout batch and it shows up here."
            action={<button className="btn primary" onClick={() => navigate("/portal/settings")}>Set up payouts</button>}
          />
        ) : (
          <Card flush title={`Payout history · ${payouts.length}`} sub="amount, method, and where each one stands">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Method</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p, i) => (
                  <tr key={p.id ?? `${p.ts}-${i}`}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{shortDate(p.ts)}</div>
                      {p.id && <div className="faint mono" style={{ fontSize: 11 }}>{p.id}</div>}
                    </td>
                    <td className="muted" style={{ fontSize: 12.5, textTransform: "capitalize" }}>{humanize(p.method)}</td>
                    <td>
                      {/* The failure reason is the merchant's own note (or a provider error) and is
                          deliberately not shown to the affiliate. */}
                      <Badge kind={statusKind(p.status)}>{statusLabel(p.status)}</Badge>
                    </td>
                    <td className="num mono">{money(p.amountCents, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      <div className="mt-24">
        <Card title="What gates a payout" sub="three things, all in your hands — set them once">
          <div className="grid grid-3 mt-16">
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Tax form on file</strong>
              <p style={{ marginTop: 4 }}>A merchant can't include you in a payout until your tax form is certified. Add it in settings — it takes a minute and applies to every future payout.</p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Payout details</strong>
              <p style={{ marginTop: 4 }}>Tell merchants where to send your money — a PayPal email, Wise details, or another account. They pay you directly; nothing passes through Vantage.</p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Minimum threshold</strong>
              <p style={{ marginTop: 4 }}>Balances below a merchant's minimum roll forward instead of triggering tiny transfers. Keep earning and the next batch picks it all up.</p>
            </div>
          </div>
          <div className="row gap-8 mt-16">
            <button className="btn sm" onClick={() => navigate("/portal/settings")}>
              Payout settings →
            </button>
            <button className="btn sm ghost" onClick={() => navigate("/portal/statement")}>
              View statement
            </button>
          </div>
        </Card>
      </div>
    </>
  );
}
