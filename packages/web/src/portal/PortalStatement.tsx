import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, statusKind } from "../ui";
import { api, money, num, shortDate } from "../api";
import { navigate } from "../router";

interface LedgerEntry {
  id: string;
  type: string;
  status: string;
  amountCents: number;
  currency: string;
  description?: string | null;
  createdAt: string | null;
}

interface Balance {
  currency: string;
  pendingCents: number;
  availableCents: number;
  onHoldCents: number;
  paidCents: number;
  reversedCents: number;
}

interface StatementResponse {
  entries?: LedgerEntry[];
  balances?: Balance[];
}

const EMPTY_BALANCE: Balance = {
  currency: "USD",
  pendingCents: 0,
  availableCents: 0,
  onHoldCents: 0,
  paidCents: 0,
  reversedCents: 0,
};

/** Be defensive about the response shape: the route may return { entries, balances },
 *  or — in some deployments — a bare array of balances. Normalize both into a
 *  predictable { entries, balances } pair. */
function normalize(data: StatementResponse | Balance[] | LedgerEntry[] | null): { entries: LedgerEntry[]; balances: Balance[] } {
  if (!data) return { entries: [], balances: [] };
  if (Array.isArray(data)) {
    // A bare array — disambiguate balances vs. entries by their fields.
    const looksLikeBalance = data.length > 0 && "availableCents" in (data[0] as object);
    if (looksLikeBalance) return { entries: [], balances: data as Balance[] };
    return { entries: data as LedgerEntry[], balances: [] };
  }
  return { entries: data.entries ?? [], balances: data.balances ?? [] };
}

export function PortalStatement() {
  const { data, loading, error, reload } = useApi<StatementResponse | Balance[] | LedgerEntry[]>(() => api.get("/portal/statement"), []);

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;

  const { entries, balances } = normalize(data);

  // Roll balances up across currencies for the headline stats. Most affiliates
  // have a single payout currency; we surface that one and aggregate cents.
  const primaryCurrency = balances[0]?.currency ?? EMPTY_BALANCE.currency;
  const totals = balances.reduce<Balance>(
    (acc, b) => ({
      currency: primaryCurrency,
      pendingCents: acc.pendingCents + b.pendingCents,
      availableCents: acc.availableCents + b.availableCents,
      onHoldCents: acc.onHoldCents + b.onHoldCents,
      paidCents: acc.paidCents + b.paidCents,
      reversedCents: acc.reversedCents + b.reversedCents,
    }),
    { ...EMPTY_BALANCE, currency: primaryCurrency }
  );

  return (
    <>
      <PageHeader
        title="Your statement"
        crumb="EARNINGS"
        subtitle="Every commission you've earned, traced from click to payout. Available is yours to withdraw; pending and on-hold clear as orders settle. Nothing is hidden — this is the full ledger."
        actions={
          <button className="btn primary" onClick={() => navigate("/portal/payouts")}>
            ⌖ Go to payouts
          </button>
        }
      />

      <div className="grid grid-4">
        <Stat label="Available" value={money(totals.availableCents, totals.currency)} foot="ready to pay out" footClass="pos" />
        <Stat label="On hold" value={money(totals.onHoldCents, totals.currency)} foot="clearing the return window" footClass="muted" />
        <Stat label="Pending" value={money(totals.pendingCents, totals.currency)} foot="awaiting settlement" footClass="muted" />
        <Stat label="Paid" value={money(totals.paidCents, totals.currency)} foot="lifetime paid to you" footClass="muted" />
      </div>

      {balances.length > 1 && (
        <div className="row gap-8" style={{ marginTop: 18 }}>
          {balances.map((b) => (
            <Badge key={b.currency} kind="info">
              {b.currency}: {money(b.availableCents, b.currency)} available
            </Badge>
          ))}
        </div>
      )}

      <div className="mt-24">
        <Card
          flush
          title={`Statement · ${entries.length} entries`}
          sub="every line is attributable — commissions, holds, reversals and payouts in one ledger"
          actions={
            <button className="btn sm ghost" onClick={reload}>
              ↻ Refresh
            </button>
          }
        >
          {entries.length === 0 ? (
            <EmptyState
              title="No ledger entries yet"
              hint="The moment a referred order lands, it shows up here as a pending commission and clears into your available balance once the return window passes."
              action={<button className="btn primary" onClick={() => navigate("/portal/links")}>Get your links</button>}
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Detail</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                  <th className="num">Date</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const negative = e.amountCents < 0;
                  return (
                    <tr key={e.id}>
                      <td>
                        <Badge kind={statusKind(e.type)}>{e.type.replace(/_/g, " ")}</Badge>
                      </td>
                      <td className="muted" style={{ fontSize: 12.5 }}>{e.description ?? "—"}</td>
                      <td>
                        <Badge kind={statusKind(e.status)}>{e.status}</Badge>
                      </td>
                      <td className={`num mono${negative ? " neg" : ""}`} style={{ fontWeight: 600 }}>
                        {money(e.amountCents, e.currency)}
                      </td>
                      <td className="num muted" style={{ fontSize: 12 }}>{shortDate(e.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid grid-3 mt-24">
        <Stat label="Entries" value={num(entries.length)} small foot="ledger lines" footClass="muted" />
        <Stat label="Reversed" value={money(totals.reversedCents, totals.currency)} small foot="clawed-back commissions" footClass={totals.reversedCents !== 0 ? "neg" : "muted"} />
        <Stat
          label="Lifetime earned"
          value={money(totals.availableCents + totals.onHoldCents + totals.pendingCents + totals.paidCents, totals.currency)}
          small
          foot="available + holds + pending + paid"
          footClass="muted"
        />
      </div>
    </>
  );
}
