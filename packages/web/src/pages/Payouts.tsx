import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, errorStatus, money, num, shortDate } from "../api";
import { centsToAmount, parseAmountToCents } from "../amounts";
import { useApi, Card, Stat, Spinner, ErrorBanner, Notice, PageHeader, Badge, EmptyState, Field, Modal, statusKind, humanize } from "../ui";

/**
 * Payout console — MANUAL payouts, no custody (AUDIT-2026-10, contract 1).
 *
 * Money never passes through the platform. Approving a batch moves its payouts to
 * `awaiting_payment` (the affiliates' balances stay reserved); the merchant then pays from
 * their OWN account — by uploading the payout file to PayPal or Wise, or by bank transfer —
 * and records the outcome here:
 *
 *   GET  /payouts/batches/:id/export?format=paypal|wise|csv   → text/csv
 *   POST /payouts/:payoutId/mark-paid    { reference? }       → settles the reservation
 *   POST /payouts/:payoutId/mark-failed  { reason }           → releases it
 *
 * A payout only skips that step when the merchant has connected their own credentials for
 * an automated rail; whatever status the API reports after approval is shown as-is.
 */

// ---- API shapes ---------------------------------------------------------------
// These mirror what the routes return today (`services/payout-service.ts`, the `Payout` /
// `PayoutBatch` entities). Anything the API can leave out is optional and read through a
// fallback; fields a later API version may add are optional too.

/** `GET /payouts/payable` */
interface PayableLine {
  affiliateId: string;
  affiliateName?: string | null;
  currency: string;
  availableCents: number;
  onHoldCents: number;
  pendingCents: number;
  taxOnFile: boolean;
  /** Where the affiliate asked to be paid (PayPal email, Wise details, …). */
  payoutAccountRef?: string | null;
  rail?: string | null;
  eligible: boolean;
  blockedReason?: string | null;
}

interface Payout {
  id: string;
  batchId?: string | null;
  affiliateId: string;
  amountCents: number;
  currency: string;
  /** The affiliate's payout method (their payout account's rail). */
  method?: string | null;
  /** pending | awaiting_payment | processing | paid | failed | held */
  status: string;
  failureReason?: string | null;
  ts?: string | null;
  // Not on the entity today — shown if the API starts returning them.
  affiliateName?: string | null;
  reference?: string | null;
}

interface PayoutBatch {
  id: string;
  currency?: string | null;
  /** draft until approved; afterwards whatever the API reports. */
  status: string;
  ts?: string | null;
}

interface CreateBatchResult {
  batch?: PayoutBatch;
  payouts?: Payout[];
  skipped?: unknown[];
}

interface AffiliateBalance {
  affiliateId: string;
  name?: string | null;
}

type ExportFormat = "paypal" | "wise" | "csv";

const EXPORT_FORMATS: { value: ExportFormat; label: string; describes: string; next: string }[] = [
  { value: "paypal", label: "PayPal", describes: "PayPal mass-pay layout", next: "Upload it under PayPal → Payouts, send it, then mark those payouts paid below." },
  { value: "wise", label: "Wise", describes: "Wise batch layout", next: "Upload it under Wise → Batch payments, fund the batch, then mark those payouts paid below." },
  { value: "csv", label: "CSV", describes: "generic CSV (affiliate, email, method, account reference, amount, currency, payout id)", next: "Use it for bank transfers or any other provider, then mark those payouts paid below." },
];

const STATUS_OPTIONS = ["awaiting_payment", "pending", "processing", "paid", "failed", "held"];

const AWAITING = "awaiting_payment";

/** "below minimum 2500" (the API reports raw cents) → "below minimum 25.00 USD". */
function blockedLabel(reason: string | null | undefined, currency: string): string {
  if (!reason) return "blocked";
  const m = /^below minimum (\d+)$/.exec(reason);
  return m ? `below minimum ${money(Number(m[1]), currency)}` : reason;
}

function forbidden(e: unknown, action: string): string | null {
  return errorStatus(e) === 403 ? `Your role can't ${action} — managers, admins and owners can.` : null;
}

export function Payouts() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Minimum payout: typed as a currency amount, sent to the API as cents. The text and
  // the committed value are separate so "25." mid-typing does not fire a request.
  const [minText, setMinText] = useState("25.00");
  const [minPayoutCents, setMinPayoutCents] = useState(2500);
  const minParsed = parseAmountToCents(minText);
  const minInvalid = minParsed === null || minParsed < 0;

  const [batchCurrency, setBatchCurrency] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [adjOpen, setAdjOpen] = useState(false);
  const [settle, setSettle] = useState<{ mode: "paid" | "failed"; targets: Payout[] } | null>(null);

  const payable = useApi<PayableLine[] | null>(() => api.get(`/payouts/payable?minPayoutCents=${minPayoutCents}`), [minPayoutCents]);
  const batches = useApi<PayoutBatch[] | null>(() => api.get("/payouts/batches"));
  // Every payout, filtered on screen: the batch totals below need the unfiltered set.
  const payouts = useApi<Payout[] | null>(() => api.get("/payouts"));
  // Names for affiliates who no longer have a payable line (their balance is reserved or paid).
  const balances = useApi<AffiliateBalance[] | null>(() => api.get("/ledger/balances"));

  useEffect(() => {
    if (minInvalid || minParsed === minPayoutCents) return;
    const t = window.setTimeout(() => setMinPayoutCents(minParsed), 450);
    return () => window.clearTimeout(t);
  }, [minParsed, minInvalid, minPayoutCents]);

  const lines = payable.data ?? [];
  const allPayouts = payouts.data ?? [];
  const batchList = batches.data ?? [];

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of balances.data ?? []) if (b?.affiliateId && b.name) map.set(b.affiliateId, b.name);
    for (const l of payable.data ?? []) if (l?.affiliateId && l.affiliateName) map.set(l.affiliateId, l.affiliateName);
    return map;
  }, [balances.data, payable.data]);
  const nameOf = (p: { affiliateId: string; affiliateName?: string | null }) => p.affiliateName ?? names.get(p.affiliateId) ?? p.affiliateId;

  const byBatch = useMemo(() => {
    const map = new Map<string, Payout[]>();
    for (const p of payouts.data ?? []) {
      if (!p.batchId) continue;
      const list = map.get(p.batchId);
      if (list) list.push(p);
      else map.set(p.batchId, [p]);
    }
    return map;
  }, [payouts.data]);

  const awaiting = allPayouts.filter((p) => p.status === AWAITING);

  // A batch is created per currency, so the headline figures follow the selected one. With
  // nothing left to batch, fall back to the currency of what is waiting to be paid.
  const currencies = useMemo(() => Array.from(new Set((payable.data ?? []).map((l) => l.currency))).sort(), [payable.data]);
  const currency = batchCurrency && currencies.includes(batchCurrency) ? batchCurrency : currencies[0] ?? awaiting[0]?.currency ?? allPayouts[0]?.currency ?? "USD";
  const scoped = lines.filter((l) => l.currency === currency);
  const eligibleLines = scoped.filter((l) => l.eligible);
  const eligibleTotal = eligibleLines.reduce((s, l) => s + l.availableCents, 0);
  const onHoldTotal = scoped.reduce((s, l) => s + l.onHoldCents, 0);
  const blockedCount = lines.filter((l) => !l.eligible).length;
  const noTaxCount = lines.filter((l) => !l.taxOnFile).length;

  const awaitingInCurrency = awaiting.filter((p) => p.currency === currency);
  const awaitingTotal = awaitingInCurrency.reduce((s, p) => s + p.amountCents, 0);
  const shownPayouts = statusFilter ? allPayouts.filter((p) => p.status === statusFilter) : allPayouts;

  function flash(m: string) {
    setMsg(m);
    setErr(null);
  }
  function fail(e: unknown, fallback: string, action?: string) {
    setErr((action && forbidden(e, action)) || errorMessage(e, fallback));
    setMsg(null);
  }
  function reloadAll() {
    payable.reload();
    batches.reload();
    payouts.reload();
    balances.reload();
  }

  async function createBatch() {
    setBusy(true);
    try {
      const res = (await api.post<CreateBatchResult | null>("/payouts/batches", { currency, minPayoutCents })) ?? {};
      const made = res.payouts?.length ?? 0;
      const skipped = res.skipped?.length ?? 0;
      flash(
        made > 0
          ? `Draft batch created with ${made} payout${made === 1 ? "" : "s"}${skipped ? ` (${skipped} affiliate${skipped === 1 ? " was" : "s were"} not eligible)` : ""}. Their balances are reserved — approve the batch when you are ready to pay.`
          : "A batch was created, but no affiliate was eligible, so it has no payouts.",
      );
      reloadAll();
    } catch (e) {
      fail(e, "Could not create the batch.", "create payout batches");
    } finally {
      setBusy(false);
    }
  }

  async function approveBatch(b: PayoutBatch) {
    setBusy(true);
    try {
      const res = await api.post<Payout[] | { payouts?: Payout[] } | null>(`/payouts/batches/${encodeURIComponent(b.id)}/approve`, {});
      const results: Payout[] = Array.isArray(res) ? res : res?.payouts ?? [];
      const count = (status: string) => results.filter((p) => p.status === status).length;
      const parts: string[] = [];
      if (count(AWAITING)) parts.push(`${count(AWAITING)} awaiting your payment — download the payout file, pay from your own account, then mark them paid`);
      // Only possible on an automated rail (the merchant's own connected provider, or the
      // mock rail outside production) — say what happened without claiming who paid.
      if (count("paid")) parts.push(`${count("paid")} marked paid by an automated payout rail`);
      if (count("processing")) parts.push(`${count("processing")} in progress on an automated payout rail`);
      if (count("failed")) parts.push(`${count("failed")} failed`);
      flash(parts.length ? `Batch approved: ${parts.join("; ")}.` : "Batch approved.");
      reloadAll();
    } catch (e) {
      fail(e, "Could not approve the batch.", "approve payout batches");
      if (errorStatus(e) === 409) reloadAll(); // approved elsewhere in the meantime
    } finally {
      setBusy(false);
    }
  }

  async function downloadFile(b: PayoutBatch, format: (typeof EXPORT_FORMATS)[number]) {
    setBusy(true);
    try {
      const { filename } = await api.download(
        `/payouts/batches/${encodeURIComponent(b.id)}/export?format=${format.value}`,
        `vantage-payouts-${b.id}-${format.value}.csv`,
      );
      flash(`Downloaded ${filename} — ${format.describes}. ${format.next}`);
    } catch (e) {
      fail(e, "Could not download the payout file.", "export payout files");
    } finally {
      setBusy(false);
    }
  }

  async function retry(p: Payout) {
    setBusy(true);
    try {
      await api.post(`/payouts/${encodeURIComponent(p.id)}/retry`, {});
      flash(`Retrying the payout to ${nameOf(p)}.`);
      reloadAll();
    } catch (e) {
      fail(e, "Retry failed.", "retry payouts");
    } finally {
      setBusy(false);
    }
  }

  if (payable.loading && batches.loading && payouts.loading && !payable.data) return <Spinner />;
  if (payable.error && !payable.data) return <ErrorBanner message={payable.error} />;

  return (
    <>
      <PageHeader
        title="Payout console"
        crumb="DISBURSEMENT · YOU PAY, WE KEEP THE BOOKS"
        subtitle="Vantage never holds or moves your money. It works out who is owed what; you pay affiliates from your own PayPal, Wise or bank account and record each payment here. Nobody is payable until their tax form is on file."
        actions={
          <>
            <button className="btn ghost" onClick={() => setAdjOpen(true)} disabled={busy}>
              + Adjustment
            </button>
            {currencies.length > 1 && (
              <select className="select" value={currency} onChange={(e) => setBatchCurrency(e.target.value)} style={{ width: "auto" }} aria-label="Batch currency">
                {currencies.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            <button className="btn primary" onClick={createBatch} disabled={busy || eligibleLines.length === 0}>
              {busy ? "working…" : `◇ Create batch · ${eligibleLines.length}`}
            </button>
          </>
        }
      />

      {msg && <Notice kind="ok">{msg}</Notice>}
      {err && <ErrorBanner message={err} />}
      {payable.error && <ErrorBanner message={payable.error} />}

      <div className="flow" style={{ marginBottom: 18 }}>
        <div className="flow-step">
          <div className="n">01 · BATCH</div>
          <div className="t">Create a batch</div>
          <div className="d">Locks in what each eligible affiliate is owed and reserves it, so nobody can be paid twice.</div>
        </div>
        <div className="flow-step">
          <div className="n">02 · APPROVE</div>
          <div className="t">Approve it</div>
          <div className="d">Its payouts move to "awaiting payment". Nothing has been sent — the next step is yours.</div>
        </div>
        <div className="flow-step">
          <div className="n">03 · PAY</div>
          <div className="t">Pay from your own account</div>
          <div className="d">Download the payout file and upload it to PayPal or Wise, or pay by bank transfer.</div>
        </div>
        <div className="flow-step">
          <div className="n">04 · RECORD</div>
          <div className="t">Mark paid or failed</div>
          <div className="d">Paid settles the affiliate's balance. Failed releases it back so your next batch picks it up.</div>
        </div>
      </div>

      <div className="grid grid-4">
        <Stat label="Eligible to pay" value={money(eligibleTotal, currency)} foot={`${num(eligibleLines.length)} affiliate${eligibleLines.length === 1 ? "" : "s"}`} />
        <Stat
          label="Awaiting your payment"
          value={money(awaitingTotal, currency)}
          foot={
            awaiting.length === 0
              ? "nothing approved and unpaid"
              : `${num(awaiting.length)} payout${awaiting.length === 1 ? "" : "s"}${awaiting.length > awaitingInCurrency.length ? ` · ${num(awaiting.length - awaitingInCurrency.length)} in other currencies` : ""}`
          }
          footClass={awaiting.length ? "warn" : "muted"}
        />
        <Stat label="On hold" value={money(onHoldTotal, currency)} foot="awaiting clearance" footClass="muted" />
        <Stat
          label="Blocked"
          value={num(blockedCount)}
          foot={noTaxCount ? `${num(noTaxCount)} missing a tax form` : "gated lines"}
          footClass={noTaxCount ? "warn" : blockedCount ? "neg" : "muted"}
        />
      </div>

      <div className="mt-24">
        <Card
          flush
          title="Payable"
          sub="available balances by affiliate — eligibility is gated on tax form, payout account and the minimum"
          actions={
            <Field label={`Minimum payout (${currency})`}>
              <input
                className="input mono"
                inputMode="decimal"
                style={{ width: 130, borderColor: minInvalid ? "var(--neg)" : undefined }}
                value={minText}
                aria-invalid={minInvalid}
                title={minInvalid ? "Enter an amount such as 25 or 25.00" : undefined}
                onChange={(e) => setMinText(e.target.value)}
                onBlur={() => setMinText(centsToAmount(minInvalid ? minPayoutCents : minParsed))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !minInvalid) setMinPayoutCents(minParsed);
                }}
              />
            </Field>
          }
        >
          {lines.length === 0 ? (
            <EmptyState
              title="Nothing payable"
              hint="No affiliate has a pending, on-hold or available balance yet. Balances appear here as conversions are approved and clear their hold period."
            />
          ) : (
            <div style={{ overflow: "auto", opacity: payable.loading ? 0.6 : 1, transition: "opacity .15s" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Affiliate</th>
                    <th>Pays via</th>
                    <th>Tax form</th>
                    <th>Status</th>
                    <th className="num">Pending</th>
                    <th className="num">On hold</th>
                    <th className="num">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={`${l.affiliateId}-${l.currency}`}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{l.affiliateName ?? l.affiliateId}</div>
                        <div className="faint mono" style={{ fontSize: 11 }}>{l.affiliateId}</div>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {l.rail ? humanize(l.rail) : <span className="faint">no account</span>}
                        {l.payoutAccountRef && <div className="faint mono" style={{ fontSize: 11 }}>{l.payoutAccountRef}</div>}
                      </td>
                      <td>
                        {l.taxOnFile ? <Badge kind="pos">on file</Badge> : <Badge kind="warn">missing</Badge>}
                      </td>
                      <td>
                        {l.eligible ? <Badge kind="pos">eligible</Badge> : <Badge kind="warn">{blockedLabel(l.blockedReason, l.currency)}</Badge>}
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
        <Card flush title="Batches" sub="approve a batch, download its payout file, pay from your own account, then mark the payouts paid">
          {batches.loading && !batches.data ? (
            <div style={{ padding: 20 }}><Spinner /></div>
          ) : batches.error ? (
            <div style={{ padding: 16 }}><ErrorBanner message={batches.error} /></div>
          ) : batchList.length === 0 ? (
            <EmptyState title="No batches yet" hint="Create a batch from the eligible lines above. It starts as a draft: the balances are reserved, and nothing becomes payable until you approve it." />
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
                    <th>Payout file</th>
                    <th className="num">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {batchList.map((b) => {
                    const members = byBatch.get(b.id) ?? [];
                    const total = members.reduce((s, p) => s + p.amountCents, 0);
                    const unpaid = members.filter((p) => p.status === AWAITING);
                    const isDraft = b.status === "draft";
                    const batchCcy = b.currency ?? members[0]?.currency ?? currency;
                    return (
                      <tr key={b.id}>
                        <td className="mono" style={{ fontSize: 12 }}>{b.id}</td>
                        <td className="muted" style={{ fontSize: 12 }}>{shortDate(b.ts)}</td>
                        <td>
                          {unpaid.length > 0 ? (
                            <>
                              <Badge kind="warn">awaiting payment</Badge>
                              <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                                {unpaid.length} of {members.length} unpaid
                              </div>
                            </>
                          ) : (
                            <Badge kind={statusKind(b.status)}>{humanize(b.status)}</Badge>
                          )}
                        </td>
                        <td className="num">{payouts.data ? num(members.length) : "—"}</td>
                        <td className="num" style={{ fontWeight: 600 }}>{payouts.data ? money(total, batchCcy) : "—"}</td>
                        <td>
                          {isDraft ? (
                            <span className="faint" style={{ fontSize: 12 }}>after approval</span>
                          ) : (
                            <div className="btn-set" role="group" aria-label="Download payout file">
                              {EXPORT_FORMATS.map((f) => (
                                <button key={f.value} className="btn sm" onClick={() => downloadFile(b, f)} disabled={busy} title={`Download the ${f.describes}`}>
                                  ⇩ {f.label}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="num">
                          {isDraft ? (
                            <button className="btn primary sm" onClick={() => approveBatch(b)} disabled={busy}>
                              Approve batch
                            </button>
                          ) : unpaid.length > 1 ? (
                            <button className="btn sm" onClick={() => setSettle({ mode: "paid", targets: unpaid })} disabled={busy}>
                              Mark all {unpaid.length} paid
                            </button>
                          ) : (
                            <span className="faint">—</span>
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
          title={`Payouts${awaiting.length ? ` · ${awaiting.length} awaiting your payment` : ""}`}
          sub="one row per affiliate payment — record what you have paid, and what bounced"
          actions={
            <Field label="Status">
              <select className="select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">all</option>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </select>
            </Field>
          }
        >
          {payouts.loading && !payouts.data ? (
            <div style={{ padding: 20 }}><Spinner /></div>
          ) : payouts.error ? (
            <div style={{ padding: 16 }}><ErrorBanner message={payouts.error} /></div>
          ) : shownPayouts.length === 0 ? (
            <EmptyState
              title={statusFilter ? `No ${humanize(statusFilter)} payouts` : "No payouts"}
              hint={statusFilter ? "Change the status filter to see the rest." : "Create and approve a batch. Each affiliate payment then appears here for you to pay and record."}
            />
          ) : (
            <div style={{ overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Affiliate</th>
                    <th>Pays via</th>
                    <th>Created</th>
                    <th>Status</th>
                    <th className="num">Amount</th>
                    <th className="num">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {shownPayouts.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{nameOf(p)}</div>
                        <div className="faint mono" style={{ fontSize: 11 }}>{p.id}</div>
                        {p.failureReason && <div className="neg" style={{ fontSize: 11 }}>{p.failureReason}</div>}
                        {p.reference && <div className="faint" style={{ fontSize: 11 }}>ref: <span className="mono">{p.reference}</span></div>}
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{humanize(p.method)}</td>
                      <td className="muted" style={{ fontSize: 12 }}>{shortDate(p.ts)}</td>
                      <td><Badge kind={statusKind(p.status)}>{humanize(p.status)}</Badge></td>
                      <td className="num" style={{ fontWeight: 600 }}>{money(p.amountCents, p.currency)}</td>
                      <td className="num">
                        {p.status === AWAITING ? (
                          <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
                            <button className="btn primary sm" onClick={() => setSettle({ mode: "paid", targets: [p] })} disabled={busy}>
                              Mark paid
                            </button>
                            <button className="btn ghost sm" onClick={() => setSettle({ mode: "failed", targets: [p] })} disabled={busy}>
                              Mark failed
                            </button>
                          </div>
                        ) : p.status === "failed" ? (
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

      {settle && (
        <SettleModal
          key={`${settle.mode}:${settle.targets.map((t) => t.id).join(",")}`}
          mode={settle.mode}
          targets={settle.targets}
          nameOf={nameOf}
          onClose={() => setSettle(null)}
          onDone={(message, isError) => {
            setSettle(null);
            if (isError) {
              setErr(message);
              setMsg(null);
            } else {
              flash(message);
            }
            reloadAll();
          }}
        />
      )}

      {adjOpen && (
        <AdjustmentModal
          defaultCurrency={currency}
          affiliates={Array.from(names, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))}
          onClose={() => setAdjOpen(false)}
          onPosted={() => {
            setAdjOpen(false);
            flash("Adjustment posted to the ledger.");
            reloadAll();
          }}
        />
      )}
    </>
  );
}

// ---- Mark paid / mark failed -------------------------------------------------

/**
 * Records the outcome of a payment the merchant made themselves. One payout normally;
 * "Mark all paid" on a batch passes several and walks the same per-payout route for each
 * (there is no bulk route), stopping at the first one the API refuses.
 */
function SettleModal({
  mode,
  targets,
  nameOf,
  onClose,
  onDone,
}: {
  mode: "paid" | "failed";
  targets: Payout[];
  nameOf: (p: Payout) => string;
  onClose: () => void;
  onDone: (message: string, isError: boolean) => void;
}) {
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const working = progress !== null;
  const many = targets.length > 1;
  const first = targets[0];
  // Summed per currency: a batch is single-currency, but do not assume it.
  const totals = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of targets) map.set(t.currency, (map.get(t.currency) ?? 0) + t.amountCents);
    return Array.from(map, ([ccy, cents]) => money(cents, ccy)).join(" + ");
  }, [targets]);

  if (!first) return null;

  async function submit() {
    setError(null);
    const body = mode === "paid" ? (reference.trim() ? { reference: reference.trim() } : {}) : { reason: reason.trim() };
    const path = mode === "paid" ? "mark-paid" : "mark-failed";
    let done = 0;
    setProgress(0);
    for (const target of targets) {
      try {
        await api.post(`/payouts/${encodeURIComponent(target.id)}/${path}`, body);
        done++;
        setProgress(done);
      } catch (e) {
        const why =
          forbidden(e, "record payouts") ??
          (errorStatus(e) === 409 ? "it is no longer awaiting payment (it may have been updated in another tab)" : errorMessage(e, "the server refused it"));
        if (done === 0 && !many) {
          // Nothing changed — stay open so the reference/reason is not lost.
          setProgress(null);
          setError(`Could not mark it ${mode}: ${why}`);
          return;
        }
        onDone(`Marked ${done} of ${targets.length} ${mode}, then stopped at ${nameOf(target)}: ${why}`, true);
        return;
      }
    }
    onDone(
      mode === "paid"
        ? many
          ? `Marked ${done} payouts paid (${totals}). Those balances are settled.`
          : `Marked paid: ${nameOf(first!)} · ${totals}. That balance is settled.`
        : `Marked failed: ${nameOf(first!)} · ${totals}. The amount is back in their available balance for your next batch.`,
      false,
    );
  }

  return (
    <Modal open onClose={working ? () => {} : onClose} title={mode === "paid" ? (many ? `Mark ${targets.length} payouts paid` : "Mark payout paid") : "Mark payout failed"}>
      <div style={{ padding: "4px 0" }}>
        {error && <ErrorBanner message={error} />}
        <div className="card" style={{ background: "var(--ink-850)", padding: 14, marginBottom: 14 }}>
          <div className="row between">
            <span style={{ fontWeight: 600 }}>{many ? `${targets.length} affiliates` : nameOf(first)}</span>
            <span className="mono" style={{ fontWeight: 600 }}>{totals}</span>
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 4 }}>
            {many ? "every payout in this batch still awaiting payment" : <>via {humanize(first.method)} · <span className="mono">{first.id}</span></>}
          </div>
        </div>

        {mode === "paid" ? (
          <>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>
              Only do this once the money has left <strong>your</strong> account. Vantage does not send anything — this records that you paid, and
              settles the affiliate{many ? "s'" : "'s"} balance.
            </p>
            <Field label={many ? "Payment reference (optional — applied to all of them)" : "Payment reference (optional)"}>
              <input
                className="input"
                value={reference}
                disabled={working}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. PayPal batch ID, Wise transfer number, bank reference"
                autoFocus
              />
            </Field>
          </>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 12px" }}>
              Use this when the payment could not be made or came back. The reserved amount is released to the affiliate's available balance, so your
              next batch picks it up once the problem is fixed.
            </p>
            <Field label="What went wrong?">
              <input
                className="input"
                value={reason}
                disabled={working}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. PayPal account not found, bank details rejected"
                autoFocus
              />
            </Field>
          </>
        )}

        {working && many && (
          <div className="faint mono" style={{ fontSize: 12, marginBottom: 8 }}>
            recording {progress} of {targets.length}…
          </div>
        )}

        <div className="row gap-8 mt-16">
          <button className={`btn ${mode === "paid" ? "primary" : "danger"}`} onClick={submit} disabled={working || (mode === "failed" && !reason.trim())}>
            {working ? "recording…" : mode === "paid" ? (many ? `Yes, I paid all ${targets.length}` : "Yes, I paid this") : "Mark failed"}
          </button>
          <button className="btn ghost" onClick={onClose} disabled={working}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- Manual adjustment -------------------------------------------------------

function AdjustmentModal({
  defaultCurrency,
  affiliates,
  onClose,
  onPosted,
}: {
  defaultCurrency: string;
  affiliates: { id: string; name: string }[];
  onClose: () => void;
  onPosted: () => void;
}) {
  const [affiliateId, setAffiliateId] = useState(affiliates[0]?.id ?? "");
  // No known affiliates yet (or one that has no ledger entries): type the id.
  const [manual, setManual] = useState(affiliates.length === 0);
  const [amountText, setAmountText] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = parseAmountToCents(amountText);
  const currencyOptions = Array.from(new Set([defaultCurrency, "USD", "EUR", "GBP"]));
  const ready = affiliateId.trim() !== "" && cents !== null && cents !== 0 && reason.trim() !== "";

  async function submit() {
    if (cents === null || cents === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/payouts/adjustments", { affiliateId: affiliateId.trim(), amountCents: cents, currency, reason: reason.trim() });
      onPosted();
    } catch (e) {
      setError(
        forbidden(e, "post adjustments") ??
          (errorStatus(e) === 404 ? "That affiliate isn't on your roster — check the ID." : errorMessage(e, "Could not post the adjustment.")),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Post adjustment">
      <div style={{ padding: "4px 0" }}>
        {error && <ErrorBanner message={error} />}
        <Field label="Affiliate">
          {manual ? (
            <input className="input mono" value={affiliateId} onChange={(e) => setAffiliateId(e.target.value)} placeholder="aff_…" autoFocus />
          ) : (
            <select className="select" value={affiliateId} onChange={(e) => setAffiliateId(e.target.value)}>
              {affiliates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.id}
                </option>
              ))}
            </select>
          )}
        </Field>
        {affiliates.length > 0 && (
          <div className="faint" style={{ fontSize: 11.5, marginTop: -8, marginBottom: 12 }}>
            <a
              href="#"
              style={{ textDecoration: "underline" }}
              onClick={(e) => {
                e.preventDefault();
                setManual((m) => !m);
                setAffiliateId(manual ? affiliates[0]!.id : "");
              }}
            >
              {manual ? "Pick from the list instead" : "Not listed? Enter an affiliate ID"}
            </a>
          </div>
        )}
        <div className="grid grid-2">
          <Field label="Amount">
            <input
              className="input mono"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              placeholder="25.00  (−25.00 to claw back)"
              aria-invalid={amountText.trim() !== "" && cents === null}
              style={{ borderColor: amountText.trim() !== "" && cents === null ? "var(--neg)" : undefined }}
            />
          </Field>
          <Field label="Currency">
            <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencyOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Reason">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="manual correction, goodwill credit, clawback…" />
        </Field>
        <div className="faint" style={{ fontSize: 12, marginTop: 8, minHeight: 18 }}>
          {amountText.trim() !== "" && cents === null ? (
            <span className="neg">Enter an amount such as 25 or 25.00.</span>
          ) : cents ? (
            <>
              This will {cents < 0 ? "debit" : "credit"} <strong>{money(Math.abs(cents), currency)}</strong> {cents < 0 ? "from" : "to"} the affiliate's ledger. It
              is a bookkeeping entry — no money moves.
            </>
          ) : null}
        </div>
        <div className="row gap-8 mt-16">
          <button className="btn primary" onClick={submit} disabled={busy || !ready}>
            {busy ? "posting…" : "Post adjustment"}
          </button>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
