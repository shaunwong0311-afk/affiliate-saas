import { useState } from "react";
import { api, money, num, shortDate } from "../api";
import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, Field, Modal, statusKind } from "../ui";

interface PayableLine {
  affiliateId: string;
  affiliateName: string;
  currency: string;
  availableCents: number;
  onHoldCents: number;
  pendingCents: number;
  taxOnFile: boolean;
  eligible: boolean;
  blockedReason: string | null;
  rail: string;
}

interface Payout {
  id: string;
  batchId: string | null;
  affiliateId: string;
  affiliateName: string;
  amountCents: number;
  currency: string;
  status: string;
  rail: string;
  failureReason: string | null;
  createdAt: string;
}

interface PayoutBatch {
  id: string;
  currency: string;
  status: string;
  totalCents: number;
  payoutCount: number;
  createdAt: string;
  approvedAt: string | null;
  payouts?: Payout[];
}

interface CreateBatchResult {
  batch: PayoutBatch;
  payouts: Payout[];
  skipped: { affiliateId: string; affiliateName: string; reason: string }[];
}

export function Payouts() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [minPayout, setMinPayout] = useState(2500);
  const [adjOpen, setAdjOpen] = useState(false);
  const [adj, setAdj] = useState({ affiliateId: "", amountCents: 0, currency: "USD", reason: "" });
  const [statusFilter, setStatusFilter] = useState("");

  const payable = useApi<PayableLine[]>(() => api.get(`/payouts/payable?minPayoutCents=${minPayout}`), [minPayout]);
  const batches = useApi<PayoutBatch[]>(() => api.get("/payouts/batches"));
  const payouts = useApi<Payout[]>(() => api.get(`/payouts${statusFilter ? `?status=${statusFilter}` : ""}`), [statusFilter]);

  const lines = payable.data ?? [];
  const eligibleLines = lines.filter((l) => l.eligible);
  const eligibleTotal = eligibleLines.reduce((s, l) => s + l.availableCents, 0);
  const onHoldTotal = lines.reduce((s, l) => s + l.onHoldCents, 0);
  const blockedCount = lines.filter((l) => !l.eligible).length;
  const noTaxCount = lines.filter((l) => !l.taxOnFile).length;
  const currency = lines[0]?.currency ?? "USD";

  function flash(m: string) {
    setMsg(m);
    setErr(null);
  }
  function fail(e: any, fallback: string) {
    setErr(e?.message ?? fallback);
    setMsg(null);
  }

  async function createBatch() {
    setBusy(true);
    try {
      const res = await api.post<CreateBatchResult>("/payouts/batches", { currency, minPayoutCents: minPayout });
      flash(`Batch created: ${res.payouts.length} payouts queued${res.skipped.length ? `, ${res.skipped.length} skipped (gated)` : ""}.`);
      payable.reload();
      batches.reload();
      payouts.reload();
    } catch (e: any) {
      fail(e, "batch creation failed");
    } finally {
      setBusy(false);
    }
  }

  async function approveBatch(b: PayoutBatch) {
    setBusy(true);
    try {
      const res = await api.post<Payout[]>(`/payouts/batches/${b.id}/approve`, {});
      flash(`Disbursed ${res.length} payouts through the rail.`);
      batches.reload();
      payouts.reload();
      payable.reload();
    } catch (e: any) {
      fail(e, "approve failed");
    } finally {
      setBusy(false);
    }
  }

  async function retry(p: Payout) {
    setBusy(true);
    try {
      await api.post(`/payouts/${p.id}/retry`, {});
      flash(`Retrying payout to ${p.affiliateName}.`);
      payouts.reload();
      batches.reload();
    } catch (e: any) {
      fail(e, "retry failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitAdjustment() {
    if (!adj.affiliateId || !adj.amountCents) {
      setErr("affiliate and non-zero amount required");
      return;
    }
    setBusy(true);
    try {
      await api.post("/payouts/adjustments", { affiliateId: adj.affiliateId, amountCents: adj.amountCents, currency: adj.currency, reason: adj.reason });
      flash("Adjustment posted to ledger.");
      setAdjOpen(false);
      setAdj({ affiliateId: "", amountCents: 0, currency: "USD", reason: "" });
      payable.reload();
      payouts.reload();
    } catch (e: any) {
      fail(e, "adjustment failed");
    } finally {
      setBusy(false);
    }
  }

  if (payable.loading && batches.loading && payouts.loading) return <Spinner />;
  if (payable.error) return <ErrorBanner message={payable.error} />;

  return (
    <>
      <PageHeader
        title="Payout console"
        crumb="DISBURSEMENT"
        subtitle="We orchestrate the money, we never custody it. Funds move affiliate-direct through the rail — and nobody gets paid until their tax form is on file."
        actions={
          <>
            <button className="btn ghost" onClick={() => setAdjOpen(true)} disabled={busy}>
              + Adjustment
            </button>
            <button className="btn primary" onClick={createBatch} disabled={busy || eligibleLines.length === 0}>
              {busy ? "working…" : `◇ Create batch · ${eligibleLines.length}`}
            </button>
          </>
        }
      />

      {msg && (
        <div className="err-banner" style={{ background: "var(--acc-glow)", borderColor: "var(--acc-dim)", color: "var(--acc)" }}>
          {msg}
        </div>
      )}
      {err && <ErrorBanner message={err} />}

      <div className="grid grid-4">
        <Stat label="Eligible to pay" value={money(eligibleTotal, currency)} foot={`${eligibleLines.length} affiliates`} />
        <Stat label="On hold" value={money(onHoldTotal, currency)} foot="awaiting clearance" footClass="muted" />
        <Stat label="Blocked" value={num(blockedCount)} foot="gated lines" footClass={blockedCount ? "neg" : "muted"} />
        <Stat label="Missing tax form" value={num(noTaxCount)} foot="cannot disburse" footClass={noTaxCount ? "warn" : "muted"} />
      </div>

      <div className="mt-24">
        <Card
          flush
          title="Payable"
          sub="available balances by affiliate — eligibility is gated on tax form + clearance"
          actions={
            <Field label="Min payout (cents)">
              <input
                className="input"
                type="number"
                style={{ width: 130 }}
                value={minPayout}
                min={0}
                onChange={(e) => setMinPayout(Math.max(0, Number(e.target.value) || 0))}
              />
            </Field>
          }
        >
          {lines.length === 0 ? (
            <EmptyState title="Nothing payable" hint="No affiliates clear the minimum threshold right now. Lower the floor or wait for balances to mature." />
          ) : (
            <div style={{ overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Affiliate</th>
                    <th>Rail</th>
                    <th>Tax form</th>
                    <th>Status</th>
                    <th className="num">Pending</th>
                    <th className="num">On hold</th>
                    <th className="num">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.affiliateId}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{l.affiliateName}</div>
                        <div className="faint mono" style={{ fontSize: 11 }}>{l.affiliateId}</div>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{l.rail}</td>
                      <td>
                        {l.taxOnFile ? <Badge kind="pos">on file</Badge> : <Badge kind="warn">missing</Badge>}
                      </td>
                      <td>
                        {l.eligible ? (
                          <Badge kind="pos">eligible</Badge>
                        ) : (
                          <Badge kind="warn">{l.blockedReason ?? "blocked"}</Badge>
                        )}
                      </td>
                      <td className="num muted">{money(l.pendingCents, l.currency)}</td>
                      <td className="num muted">{money(l.onHoldCents, l.currency)}</td>
                      <td className="num" style={{ fontWeight: 600, color: l.eligible ? "var(--acc)" : "var(--text-dim)" }}>
                        {money(l.availableCents, l.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-24">
        <Card flush title="Batches" sub="approve to disburse — funds move affiliate-direct, no custody on our balance sheet">
          {batches.loading ? (
            <div style={{ padding: 20 }}><Spinner /></div>
          ) : (batches.data ?? []).length === 0 ? (
            <EmptyState title="No batches yet" hint="Create a batch from eligible payable lines, then approve to disburse through the rail." />
          ) : (
            <div style={{ overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>Created</th>
                    <th>Status</th>
                    <th className="num">Payouts</th>
                    <th className="num">Total</th>
                    <th className="num">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(batches.data ?? []).map((b) => {
                    const approvable = b.status === "draft" || b.status === "pending" || b.status === "queued";
                    return (
                      <tr key={b.id}>
                        <td className="mono" style={{ fontSize: 12 }}>{b.id}</td>
                        <td className="muted" style={{ fontSize: 12 }}>{shortDate(b.createdAt)}</td>
                        <td><Badge kind={statusKind(b.status)}>{b.status}</Badge></td>
                        <td className="num">{num(b.payoutCount)}</td>
                        <td className="num" style={{ fontWeight: 600 }}>{money(b.totalCents, b.currency)}</td>
                        <td className="num">
                          {approvable ? (
                            <button className="btn primary sm" onClick={() => approveBatch(b)} disabled={busy}>
                              Approve & disburse
                            </button>
                          ) : (
                            <span className="faint">{b.approvedAt ? shortDate(b.approvedAt) : "—"}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-24">
        <Card
          flush
          title="Payouts"
          sub="individual disbursements through the rail — retry transient rail failures"
          actions={
            <Field label="Status">
              <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">all</option>
                <option value="pending">pending</option>
                <option value="processing">processing</option>
                <option value="paid">paid</option>
                <option value="failed">failed</option>
                <option value="reversed">reversed</option>
              </select>
            </Field>
          }
        >
          {payouts.loading ? (
            <div style={{ padding: 20 }}><Spinner /></div>
          ) : payouts.error ? (
            <div style={{ padding: 16 }}><ErrorBanner message={payouts.error} /></div>
          ) : (payouts.data ?? []).length === 0 ? (
            <EmptyState title="No payouts" hint="Approve a batch to disburse. Disbursements will appear here with their rail status." />
          ) : (
            <div style={{ overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Affiliate</th>
                    <th>Rail</th>
                    <th>Created</th>
                    <th>Status</th>
                    <th className="num">Amount</th>
                    <th className="num">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(payouts.data ?? []).map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{p.affiliateName}</div>
                        {p.failureReason && <div className="neg" style={{ fontSize: 11 }}>{p.failureReason}</div>}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{p.rail}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{shortDate(p.createdAt)}</td>
                      <td><Badge kind={statusKind(p.status)}>{p.status}</Badge></td>
                      <td className="num" style={{ fontWeight: 600 }}>{money(p.amountCents, p.currency)}</td>
                      <td className="num">
                        {p.status === "failed" ? (
                          <button className="btn sm" onClick={() => retry(p)} disabled={busy}>
                            Retry
                          </button>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Modal open={adjOpen} onClose={() => setAdjOpen(false)} title="Post adjustment">
        <div style={{ padding: "4px 20px 20px" }}>
          <Field label="Affiliate ID">
            <input className="input" value={adj.affiliateId} onChange={(e) => setAdj({ ...adj, affiliateId: e.target.value })} placeholder="aff_…" />
          </Field>
          <div className="grid grid-2">
            <Field label="Amount (cents)">
              <input
                className="input"
                type="number"
                value={adj.amountCents}
                onChange={(e) => setAdj({ ...adj, amountCents: Number(e.target.value) || 0 })}
                placeholder="negative to claw back"
              />
            </Field>
            <Field label="Currency">
              <select className="select" value={adj.currency} onChange={(e) => setAdj({ ...adj, currency: e.target.value })}>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
              </select>
            </Field>
          </div>
          <Field label="Reason">
            <input className="input" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} placeholder="manual correction, goodwill credit, clawback…" />
          </Field>
          <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
            {adj.amountCents !== 0 && (
              <>This will {adj.amountCents < 0 ? "debit" : "credit"} <strong>{money(adj.amountCents, adj.currency)}</strong> to the affiliate ledger.</>
            )}
          </div>
          <div className="row gap-8 mt-16">
            <button className="btn primary" onClick={submitAdjustment} disabled={busy}>
              Post adjustment
            </button>
            <button className="btn ghost" onClick={() => setAdjOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
