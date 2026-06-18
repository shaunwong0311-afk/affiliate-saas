import { useState } from "react";
import { api, money, num, shortDate } from "../api";
import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, statusKind } from "../ui";

interface Conversion {
  id: string;
  affiliateId: string;
  amountCents: number;
  currency: string;
  status: string;
  reviewStatus: string;
  ts: string;
}

type Tab = "all" | "queue";

export function Conversions() {
  const [tab, setTab] = useState<Tab>("all");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const all = useApi<{ items: Conversion[]; total: number }>(() => api.get("/conversions?limit=100"), []);
  const queue = useApi<Conversion[]>(() => api.get("/conversions/review-queue"), []);

  function reloadAll() {
    all.reload();
    queue.reload();
  }

  async function approve(c: Conversion) {
    setBusy(c.id);
    setMsg(null);
    try {
      await api.post(`/conversions/${c.id}/approve`, {});
      setMsg(`Approved ${c.id.slice(0, 8)} · ${money(c.amountCents, c.currency)}`);
      reloadAll();
    } catch (e: any) {
      setMsg(e?.message ?? "approve failed");
    } finally {
      setBusy(null);
    }
  }

  async function reject(c: Conversion) {
    const reason = window.prompt(`Reject ${c.id.slice(0, 8)} — reason?`, "");
    if (reason === null) return;
    setBusy(c.id);
    setMsg(null);
    try {
      await api.post(`/conversions/${c.id}/reject`, { reason });
      setMsg(`Rejected ${c.id.slice(0, 8)}${reason ? ` — ${reason}` : ""}`);
      reloadAll();
    } catch (e: any) {
      setMsg(e?.message ?? "reject failed");
    } finally {
      setBusy(null);
    }
  }

  const loading = tab === "all" ? all.loading : queue.loading;
  const error = tab === "all" ? all.error : queue.error;
  const allItems = all.data?.items ?? [];
  const rows: Conversion[] = tab === "all" ? allItems : queue.data ?? [];
  const flaggedCount = queue.data?.length ?? 0;

  // Status counts computed from the full list (drives the stat row).
  const counts = allItems.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});
  const grossCents = allItems.reduce((s, c) => s + c.amountCents, 0);

  function actionable(c: Conversion): boolean {
    return c.status === "pending" || c.status === "flagged" || c.reviewStatus === "pending" || c.reviewStatus === "flagged";
  }

  return (
    <>
      <PageHeader
        title="Conversions & fraud review"
        crumb="LEDGER INTEGRITY"
        subtitle="Every commission starts here. Flagged conversions are held until a human clears them — approvals release money, rejections protect it. Trust is won at this desk."
        actions={
          <button className="btn ghost sm" onClick={reloadAll} disabled={loading}>
            ↻ Refresh
          </button>
        }
      />

      <div className="grid grid-4">
        <Stat label="Conversions" value={num(allItems.length)} foot={`${num(all.data?.total ?? allItems.length)} total`} footClass="muted" />
        <Stat label="Gross volume" value={money(grossCents)} foot="across visible window" footClass="muted" />
        <Stat label="Approved" value={num(counts.approved ?? 0)} foot={`${num(counts.pending ?? 0)} pending`} footClass="muted" />
        <Stat
          label="Flagged for review"
          value={num(flaggedCount)}
          foot={`${num(counts.rejected ?? 0)} rejected`}
          footClass={flaggedCount > 0 ? "neg" : "muted"}
        />
      </div>

      {msg && (
        <div
          className="err-banner"
          style={{ background: "var(--acc-glow)", borderColor: "var(--acc-dim)", color: "var(--acc)", marginTop: 18 }}
        >
          {msg}
        </div>
      )}

      <div className="tabs mt-24">
        <div className={`tab${tab === "all" ? " active" : ""}`} onClick={() => setTab("all")}>
          All conversions
        </div>
        <div className={`tab${tab === "queue" ? " active" : ""}`} onClick={() => setTab("queue")}>
          Review queue (flagged){flaggedCount ? ` · ${flaggedCount}` : ""}
        </div>
      </div>

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorBanner message={error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={tab === "queue" ? "Queue is clear" : "No conversions yet"}
          hint={
            tab === "queue"
              ? "Nothing is flagged for manual review. Risk signals will surface suspicious conversions here automatically."
              : "Conversions appear as affiliates drive tracked sales. Flagged ones route to the review queue before payout."
          }
        />
      ) : (
        <Card
          flush
          title={tab === "queue" ? `Flagged · ${rows.length}` : `Conversions · ${rows.length}`}
          sub={tab === "queue" ? "held pending human decision — approve to release, reject to clawback" : "newest first · approve or reject anything still pending"}
        >
          <div style={{ maxHeight: 620, overflow: "auto" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Conversion</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th>Review</th>
                  <th>Date</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="mono" style={{ fontWeight: 600 }}>{c.id.slice(0, 8)}</div>
                      <div className="faint mono" style={{ fontSize: 11 }}>aff {c.affiliateId.slice(0, 8)}</div>
                    </td>
                    <td className="num mono">{money(c.amountCents, c.currency)}</td>
                    <td>
                      <Badge kind={statusKind(c.status)}>{c.status}</Badge>
                    </td>
                    <td>
                      <Badge kind={statusKind(c.reviewStatus)}>{c.reviewStatus}</Badge>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{shortDate(c.ts)}</td>
                    <td className="num">
                      {actionable(c) ? (
                        <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
                          <button className="btn primary sm" onClick={() => approve(c)} disabled={busy === c.id}>
                            {busy === c.id ? "…" : "Approve"}
                          </button>
                          <button className="btn ghost sm" onClick={() => reject(c)} disabled={busy === c.id}>
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
