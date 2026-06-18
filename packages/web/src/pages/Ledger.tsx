import { useState } from "react";
import { api, money, shortDate } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, statusKind } from "../ui";

interface LedgerEntry {
  id: string;
  affiliateId: string;
  conversionId: string | null;
  type: string;
  amountCents: number;
  currency: string;
  status: string;
  availableAt: string | null;
  ts: string;
  metadata: Record<string, unknown> | null;
}

interface CurrencyBalance {
  currency: string;
  pendingCents: number;
  availableCents: number;
  onHoldCents: number;
  paidCents: number;
  reversedCents: number;
}

interface AffiliateBalance {
  affiliateId: string;
  name: string;
  balances: CurrencyBalance[];
}

const TYPES = ["", "commission", "bonus", "adjustment", "reversal", "payout"];
const STATUSES = ["", "pending", "available", "on_hold", "paid", "reversed"];

export function Ledger() {
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");

  const balances = useApi<AffiliateBalance[]>(() => api.get("/ledger/balances"), []);
  const entries = useApi<{ items: LedgerEntry[]; total: number }>(
    () => api.get(`/ledger?limit=200&status=${status}&type=${type}`),
    [status, type]
  );

  function posneg(cents: number): string {
    return cents < 0 ? "neg" : "pos";
  }

  return (
    <>
      <PageHeader
        title="Ledger"
        crumb="MONEY OF RECORD"
        subtitle="Append-only and immutable: every commission, hold, clawback, and payout is a new entry — balances are derived, never edited. The ledger is the single source of truth for what you owe."
      />

      <Card flush title="Balances" sub="derived from the append-only ledger, per affiliate and currency">
        {balances.loading ? (
          <Spinner />
        ) : balances.error ? (
          <ErrorBanner message={balances.error} />
        ) : !balances.data || balances.data.length === 0 ? (
          <EmptyState title="No balances yet" hint="Balances appear once conversions post commission entries to the ledger." />
        ) : (
          <div style={{ overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Affiliate</th>
                  <th>Currency</th>
                  <th className="num">Available</th>
                  <th className="num">On hold</th>
                  <th className="num">Pending</th>
                  <th className="num">Paid</th>
                  <th className="num">Reversed</th>
                </tr>
              </thead>
              <tbody>
                {balances.data.flatMap((aff) =>
                  aff.balances.map((b) => (
                    <tr key={`${aff.affiliateId}-${b.currency}`}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{aff.name}</div>
                        <div className="faint mono" style={{ fontSize: 11 }}>{aff.affiliateId}</div>
                      </td>
                      <td className="mono muted" style={{ fontSize: 12 }}>{b.currency}</td>
                      <td className={`num mono ${posneg(b.availableCents)}`}>{money(b.availableCents, b.currency)}</td>
                      <td className="num mono muted">{money(b.onHoldCents, b.currency)}</td>
                      <td className="num mono muted">{money(b.pendingCents, b.currency)}</td>
                      <td className="num mono muted">{money(b.paidCents, b.currency)}</td>
                      <td className="num mono">{money(b.reversedCents, b.currency)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-24">
        <Card
          flush
          title="Ledger entries"
          sub="append-only — newest first"
          actions={
            <div className="row gap-8">
              <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>{t === "" ? "all types" : t}</option>
                ))}
              </select>
              <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{s === "" ? "all statuses" : s.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
          }
        >
          {entries.loading ? (
            <Spinner />
          ) : entries.error ? (
            <ErrorBanner message={entries.error} />
          ) : !entries.data || entries.data.items.length === 0 ? (
            <EmptyState
              title="No entries"
              hint="No ledger entries match the current filters. Adjust the type or status filter above."
              action={
                (type || status) ? (
                  <button className="btn sm ghost" onClick={() => { setType(""); setStatus(""); }}>Clear filters</button>
                ) : undefined
              }
            />
          ) : (
            <div style={{ overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Affiliate</th>
                    <th className="num">Amount</th>
                    <th>Status</th>
                    <th>Available</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.data.items.map((e) => (
                    <tr key={e.id}>
                      <td><Badge kind={statusKind(e.type)}>{e.type.replace(/_/g, " ")}</Badge></td>
                      <td className="mono faint" style={{ fontSize: 11 }}>{e.affiliateId}</td>
                      <td className={`num mono ${e.amountCents < 0 ? "neg" : ""}`}>{money(e.amountCents, e.currency)}</td>
                      <td><Badge kind={statusKind(e.status)}>{e.status.replace(/_/g, " ")}</Badge></td>
                      <td className="muted" style={{ fontSize: 12 }}>{shortDate(e.availableAt)}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{shortDate(e.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {entries.data && entries.data.items.length > 0 && (
            <div className="faint" style={{ fontSize: 11, padding: "12px 20px" }}>
              Showing {entries.data.items.length} of {entries.data.total} entries.
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
