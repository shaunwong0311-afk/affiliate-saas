import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, statusKind } from "../ui";
import { api, money, num, shortDate } from "../api";
import { navigate } from "../router";

interface Payout {
  id?: string;
  amountCents: number;
  currency: string;
  method: string;
  status: string;
  ts: string;
}

function methodLabel(method: string): string {
  return method.replace(/_/g, " ");
}

export function PortalPayouts() {
  const { data, loading, error } = useApi<Payout[]>(() => api.get("/portal/payouts"));

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;

  const payouts = data ?? [];
  const currency = payouts[0]?.currency ?? "USD";
  const paidCents = payouts.filter((p) => statusKind(p.status) === "pos").reduce((sum, p) => sum + p.amountCents, 0);
  const pendingCents = payouts.filter((p) => statusKind(p.status) === "warn").reduce((sum, p) => sum + p.amountCents, 0);

  return (
    <>
      <PageHeader
        title="Payouts"
        crumb="PORTAL"
        subtitle="Every payout, from queued to landed. We hold nothing back you've earned — once you clear the gate, the money moves on schedule."
        actions={
          <button className="btn primary" onClick={() => navigate("/portal/settings")}>
            ⌖ Payout settings
          </button>
        }
      />

      <div
        className="err-banner"
        style={{ background: "var(--acc-glow)", borderColor: "var(--acc-dim)", color: "var(--acc)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}
      >
        <span>
          Payouts release once a tax form is on file and your balance clears the minimum threshold. Until both are met, earnings accrue but stay held.
        </span>
        <button className="btn sm" onClick={() => navigate("/portal/settings")}>
          Complete tax form →
        </button>
      </div>

      <div className="grid grid-3" style={{ marginTop: 18 }}>
        <Stat label="Paid out" value={money(paidCents, currency)} foot={`${num(payouts.filter((p) => statusKind(p.status) === "pos").length)} settled`} footClass="muted" />
        <Stat label="In flight" value={money(pendingCents, currency)} foot="pending or held" footClass={pendingCents > 0 ? "warn" : "muted"} />
        <Stat label="Payouts" value={num(payouts.length)} foot="lifetime transactions" footClass="muted" />
      </div>

      <div className="mt-24">
        {payouts.length === 0 ? (
          <EmptyState
            title="No payouts yet"
            hint="Once you've earned past the minimum threshold and your tax form is on file, your first payout schedules automatically and shows up here."
            action={<button className="btn primary" onClick={() => navigate("/portal/settings")}>Set up payouts</button>}
          />
        ) : (
          <Card flush title={`Payout history · ${payouts.length}`} sub="newest first — amount, method, and where each one stands">
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
                    <td className="muted" style={{ fontSize: 12.5, textTransform: "capitalize" }}>{methodLabel(p.method)}</td>
                    <td><Badge kind={statusKind(p.status)}>{p.status}</Badge></td>
                    <td className="num mono">{money(p.amountCents, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      <div className="mt-24">
        <Card title="What gates a payout" sub="two conditions, both on you — clear them once and payouts run on autopilot">
          <div className="grid grid-3 mt-16">
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Tax form on file</strong>
              <p style={{ marginTop: 4 }}>We can't release funds until your tax form is submitted and verified. Add it in settings — it takes a minute and unlocks every future payout.</p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Minimum threshold</strong>
              <p style={{ marginTop: 4 }}>Balances below the program minimum roll forward instead of triggering tiny transfers. Keep earning and the next cycle sweeps it all out.</p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">On schedule</strong>
              <p style={{ marginTop: 4 }}>Once both gates clear, payouts process on the program's regular cadence to the method you've set. No requests, no chasing.</p>
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
