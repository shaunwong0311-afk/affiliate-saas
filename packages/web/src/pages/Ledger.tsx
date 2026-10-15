import { useState } from "react";
import { api, money, shortDate } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, statusKind, humanize } from "../ui";

interface LedgerEntry {
  id: string;
  affiliateId: string;
  conversionId?: string | null;
  /** commission | override | bonus | adjustment | reversal */
  type: string;
  amountCents: number;
  currency: string;
  /** pending | approved | processing | paid | reversed */
  status: string;
  availableAt?: string | null;
  ts?: string | null;
  metadata?: Record<string, unknown> | null;
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
  /** null when the affiliate record is gone. */
  name?: string | null;
  balances?: CurrencyBalance[] | null;
}

// The values the ledger actually stores (`core/types/ledger.ts`). "available" and
// "on hold" are BALANCE buckets derived from approved entries, not entry statuses, and a
// payout is not an entry type — filtering on those could never match anything.
const TYPES = ["", "commission", "override", "bonus", "adjustment", "reversal"];
const STATUSES = ["", "pending", "approved", "processing", "paid", "reversed"];

export function Ledger() {
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");

  const balances = useApi<AffiliateBalance[] | null>(() => api.get("/ledger/balances"), []);
  const entries = useApi<{ items?: LedgerEntry[]; total?: number } | null>(() => {
    // Only send a filter that is set: `status=` (empty) is a filter for the empty string
    // on the API side and matches no entry at all.
    const q = new URLSearchParams({ limit: "200" });
    if (status) q.set("status", status);
    if (type) q.set("type", type);
    return api.get(`/ledger?${q.toString()}`);
  }, [status, type]);
  const entryItems = entries.data?.items ?? [];

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
                  (aff.balances ?? []).map((b) => (
                    <tr key={`${aff.affiliateId}-${b.currency}`}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{aff.name ?? "Unknown affiliate"}</div>
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
          ) : entryItems.length === 0 ? (
            <EmptyState
              title="No entries"
              hint={
                type || status
                  ? "No ledger entries match the current filters. Adjust the type or status filter above."
                  : "Entries are written as conversions are approved, reversed, adjusted and paid."
              }
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
                  {entryItems.map((e) => (
                    <tr key={e.id}>
                      <td><Badge kind={statusKind(e.type)}>{humanize(e.type)}</Badge></td>
                      <td className="mono faint" style={{ fontSize: 11 }}>{e.affiliateId}</td>
                      <td className={`num mono ${e.amountCents < 0 ? "neg" : ""}`}>{money(e.amountCents, e.currency)}</td>
                      <td><Badge kind={statusKind(e.status)}>{humanize(e.status)}</Badge></td>
                      <td className="muted" style={{ fontSize: 12 }}>{shortDate(e.availableAt)}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{shortDate(e.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {entryItems.length > 0 && (
            <div className="faint" style={{ fontSize: 11, padding: "12px 20px" }}>
              Showing {entryItems.length} of {entries.data?.total ?? entryItems.length} entries.
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
