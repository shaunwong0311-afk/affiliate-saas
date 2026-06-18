import { useState } from "react";
import { api, money, pct, num } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, Field, Modal, statusKind } from "../ui";

interface Program {
  id: string;
  name: string;
  status: string;
  approvalMode: string;
  defaultCurrency: string;
  attributionPriority: string;
  holdDays: number;
}

interface Offer {
  id: string;
  name: string;
  payoutType: "percentage" | "flat";
  payoutValue: number;
  currency: string;
  windowDays: number;
  engine: string;
  status: string;
}

interface ProgramDetail extends Program {
  offers: Offer[];
}

const APPROVAL_MODES = ["auto", "manual"];
const ATTRIBUTION = ["last_click", "first_click"];

function payoutDisplay(o: Offer): string {
  return o.payoutType === "percentage" ? pct(o.payoutValue) : money(o.payoutValue, o.currency);
}

export function Programs() {
  const programs = useApi<Program[]>(() => api.get("/programs"));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewProgram, setShowNewProgram] = useState(false);
  const [showNewOffer, setShowNewOffer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const detail = useApi<ProgramDetail>(() => (selectedId ? api.get(`/programs/${selectedId}`) : Promise.resolve(null as any)), [selectedId]);

  const [progForm, setProgForm] = useState({
    name: "",
    approvalMode: "manual",
    defaultCurrency: "USD",
    attributionPriority: "last_click",
    holdDays: 30,
  });

  const [offerForm, setOfferForm] = useState({
    name: "",
    payoutType: "percentage" as "percentage" | "flat",
    payoutValue: 0.2,
    currency: "USD",
    windowDays: 30,
  });

  async function createProgram(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const created = await api.post<Program>("/programs", {
        name: progForm.name,
        approvalMode: progForm.approvalMode,
        defaultCurrency: progForm.defaultCurrency,
        attributionPriority: progForm.attributionPriority,
        holdDays: Number(progForm.holdDays),
      });
      setShowNewProgram(false);
      setProgForm({ name: "", approvalMode: "manual", defaultCurrency: "USD", attributionPriority: "last_click", holdDays: 30 });
      programs.reload();
      if (created?.id) setSelectedId(created.id);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create program");
    } finally {
      setBusy(false);
    }
  }

  async function createOffer(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/programs/${selectedId}/offers`, {
        name: offerForm.name,
        engine: "affiliate",
        payoutType: offerForm.payoutType,
        payoutValue: Number(offerForm.payoutValue),
        currency: offerForm.currency,
        windowDays: Number(offerForm.windowDays),
        rules: [],
        tiers: [],
        bonuses: [],
        overridePolicy: null,
      });
      setShowNewOffer(false);
      setOfferForm({ name: "", payoutType: "percentage", payoutValue: 0.2, currency: "USD", windowDays: 30 });
      detail.reload();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create offer");
    } finally {
      setBusy(false);
    }
  }

  async function setProgramStatus(p: Program, status: string) {
    setErr(null);
    try {
      await api.patch(`/programs/${p.id}`, { status });
      programs.reload();
      if (selectedId === p.id) detail.reload();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to update status");
    }
  }

  if (programs.loading) return <Spinner />;
  if (programs.error) return <ErrorBanner message={programs.error} />;
  const items = programs.data ?? [];
  const active = items.filter((p) => p.status === "active").length;
  const selected = detail.data;

  return (
    <>
      <PageHeader
        title="Programs & offers"
        crumb="PROGRAM DESIGN"
        subtitle="A program is the contract: approval rules, currency, attribution, and hold. Offers are the levers — what you pay, how, and for how long the attribution window stays open."
        actions={
          <button className="btn primary" onClick={() => setShowNewProgram(true)}>
            ＋ New program
          </button>
        }
      />

      {err && <ErrorBanner message={err} />}

      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="stat">
          <div className="stat-label">Programs</div>
          <div className="stat-value mono">{num(items.length)}</div>
          <div className="stat-foot muted">{num(active)} active</div>
        </div>
        <div className="stat">
          <div className="stat-label">Active</div>
          <div className="stat-value mono">{num(active)}</div>
          <div className="stat-foot muted">live & accepting traffic</div>
        </div>
        <div className="stat">
          <div className="stat-label">Paused / draft</div>
          <div className="stat-value mono">{num(items.length - active)}</div>
          <div className="stat-foot muted">not earning</div>
        </div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="No programs yet"
          hint="Create your first program to define approval mode, default currency, attribution priority, and the hold window before commissions clear."
          action={<button className="btn primary" onClick={() => setShowNewProgram(true)}>New program</button>}
        />
      ) : (
        <div className="grid grid-2">
          <Card flush title={`Programs · ${items.length}`} sub="select a program to manage its offers">
            <div style={{ maxHeight: 560, overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Program</th>
                    <th>Approval</th>
                    <th>Status</th>
                    <th className="num">Hold</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => (
                    <tr
                      key={p.id}
                      style={{ cursor: "pointer", background: p.id === selectedId ? "var(--ink-850)" : undefined }}
                      onClick={() => setSelectedId(p.id)}
                    >
                      <td>
                        <div style={{ fontWeight: 600 }}>{p.name}</div>
                        <div className="faint mono" style={{ fontSize: 11 }}>
                          {p.defaultCurrency} · {p.attributionPriority.replace(/_/g, " ")}
                        </div>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{p.approvalMode}</td>
                      <td><Badge kind={statusKind(p.status)}>{p.status}</Badge></td>
                      <td className="num">{num(p.holdDays)}d</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card
            title={selected ? selected.name : "Program detail"}
            sub={selected ? "offers, payouts, and attribution windows" : "explainability — every offer is attributable"}
            actions={
              selected ? (
                selected.status === "active" ? (
                  <button className="btn sm ghost" onClick={() => setProgramStatus(selected, "paused")}>Pause</button>
                ) : (
                  <button className="btn primary sm" onClick={() => setProgramStatus(selected, "active")}>Activate</button>
                )
              ) : undefined
            }
          >
            {!selectedId ? (
              <EmptyState title="Select a program" hint="Pick a program on the left to see its offers, payout structure, and attribution windows — and to add new offers." />
            ) : detail.loading ? (
              <Spinner />
            ) : detail.error ? (
              <ErrorBanner message={detail.error} />
            ) : !selected ? null : (
              <div>
                <div className="row gap-8" style={{ marginBottom: 16 }}>
                  <Badge kind={statusKind(selected.status)}>{selected.status}</Badge>
                  <Badge kind="info">{selected.approvalMode} approval</Badge>
                  <Badge>{selected.defaultCurrency}</Badge>
                  <Badge>{selected.attributionPriority.replace(/_/g, " ")}</Badge>
                  <Badge kind="warn">{selected.holdDays}d hold</Badge>
                </div>

                <div className="row between" style={{ marginBottom: 8 }}>
                  <div className="card-title" style={{ fontSize: 14 }}>Offers · {selected.offers.length}</div>
                  <button className="btn sm" onClick={() => setShowNewOffer(true)}>＋ Add offer</button>
                </div>

                {selected.offers.length === 0 ? (
                  <EmptyState
                    title="No offers"
                    hint="Add an offer to define the payout — a percentage of order value or a flat amount per conversion — and the attribution window."
                    action={<button className="btn primary sm" onClick={() => setShowNewOffer(true)}>Add offer</button>}
                  />
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Offer</th>
                        <th>Type</th>
                        <th className="num">Payout</th>
                        <th className="num">Window</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.offers.map((o) => (
                        <tr key={o.id}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{o.name}</div>
                            <div className="faint mono" style={{ fontSize: 11 }}>{o.engine}</div>
                          </td>
                          <td className="muted" style={{ fontSize: 12 }}>{o.payoutType}</td>
                          <td className="num mono">{payoutDisplay(o)}</td>
                          <td className="num">{num(o.windowDays)}d</td>
                          <td><Badge kind={statusKind(o.status)}>{o.status}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      <Modal open={showNewProgram} onClose={() => setShowNewProgram(false)} title="New program">
        <form onSubmit={createProgram}>
          <Field label="Name">
            <input
              className="input"
              value={progForm.name}
              onChange={(e) => setProgForm({ ...progForm, name: e.target.value })}
              placeholder="Core Affiliate Program"
              required
              autoFocus
            />
          </Field>
          <div className="grid grid-2">
            <Field label="Approval mode">
              <select className="select" value={progForm.approvalMode} onChange={(e) => setProgForm({ ...progForm, approvalMode: e.target.value })}>
                {APPROVAL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="Default currency">
              <input className="input" value={progForm.defaultCurrency} onChange={(e) => setProgForm({ ...progForm, defaultCurrency: e.target.value.toUpperCase() })} maxLength={3} required />
            </Field>
          </div>
          <div className="grid grid-2">
            <Field label="Attribution priority">
              <select className="select" value={progForm.attributionPriority} onChange={(e) => setProgForm({ ...progForm, attributionPriority: e.target.value })}>
                {ATTRIBUTION.map((a) => <option key={a} value={a}>{a.replace(/_/g, " ")}</option>)}
              </select>
            </Field>
            <Field label="Hold days">
              <input className="input" type="number" min={0} value={progForm.holdDays} onChange={(e) => setProgForm({ ...progForm, holdDays: Number(e.target.value) })} required />
            </Field>
          </div>
          <div className="row gap-8 mt-16">
            <button type="submit" className="btn primary" disabled={busy || !progForm.name.trim()}>
              {busy ? "Creating…" : "Create program"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setShowNewProgram(false)}>Cancel</button>
          </div>
        </form>
      </Modal>

      <Modal open={showNewOffer} onClose={() => setShowNewOffer(false)} title="Add offer">
        <form onSubmit={createOffer}>
          <Field label="Name">
            <input
              className="input"
              value={offerForm.name}
              onChange={(e) => setOfferForm({ ...offerForm, name: e.target.value })}
              placeholder="Standard payout"
              required
              autoFocus
            />
          </Field>
          <div className="grid grid-2">
            <Field label="Payout type">
              <select
                className="select"
                value={offerForm.payoutType}
                onChange={(e) => {
                  const payoutType = e.target.value as "percentage" | "flat";
                  setOfferForm({ ...offerForm, payoutType, payoutValue: payoutType === "percentage" ? 0.2 : 1000 });
                }}
              >
                <option value="percentage">percentage</option>
                <option value="flat">flat</option>
              </select>
            </Field>
            <Field label={offerForm.payoutType === "percentage" ? "Payout value (decimal, 0.2 = 20%)" : "Payout value (cents)"}>
              <input
                className="input"
                type="number"
                step={offerForm.payoutType === "percentage" ? "0.01" : "1"}
                min={0}
                value={offerForm.payoutValue}
                onChange={(e) => setOfferForm({ ...offerForm, payoutValue: Number(e.target.value) })}
                required
              />
            </Field>
          </div>
          <div className="grid grid-2">
            <Field label="Currency">
              <input className="input" value={offerForm.currency} onChange={(e) => setOfferForm({ ...offerForm, currency: e.target.value.toUpperCase() })} maxLength={3} required />
            </Field>
            <Field label="Window days">
              <input className="input" type="number" min={0} value={offerForm.windowDays} onChange={(e) => setOfferForm({ ...offerForm, windowDays: Number(e.target.value) })} required />
            </Field>
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            Engine: affiliate · {offerForm.payoutType === "percentage" ? `pays ${pct(offerForm.payoutValue || 0)} of order value` : `pays ${money(offerForm.payoutValue || 0, offerForm.currency)} per conversion`}
          </div>
          <div className="row gap-8 mt-16">
            <button type="submit" className="btn primary" disabled={busy || !offerForm.name.trim()}>
              {busy ? "Adding…" : "Add offer"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setShowNewOffer(false)}>Cancel</button>
          </div>
        </form>
      </Modal>
    </>
  );
}
