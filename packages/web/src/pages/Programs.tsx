import { useState } from "react";
import { api, errorMessage, money, pct, num } from "../api";
import { parseAmountToCents } from "../amounts";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, Field, Modal, statusKind, humanize } from "../ui";

interface Program {
  id: string;
  name: string;
  status: string;
  approvalMode?: string | null;
  defaultCurrency?: string | null;
  attributionPriority?: string | null;
  holdDays?: number | null;
}

interface Offer {
  id: string;
  name: string;
  payoutType: "percentage" | "flat";
  /** A decimal rate for percentage offers (0.2 = 20%); integer cents for flat offers. */
  payoutValue: number;
  currency: string;
  windowDays?: number | null;
  engine?: string | null;
  status: string;
}

interface ProgramDetail extends Program {
  offers?: Offer[] | null;
}

type PayoutType = "percentage" | "flat";

/**
 * The offer form takes what a person would type — "20" for 20%, "10.00" for a flat $10 —
 * and converts to what the API stores: a decimal rate in (0, 1], or integer cents.
 * Returns null while the text is not a usable value.
 */
function payoutValueFrom(type: PayoutType, text: string): number | null {
  if (type === "flat") {
    const cents = parseAmountToCents(text);
    return cents !== null && cents > 0 ? cents : null;
  }
  const percent = Number(text.trim().replace(/%$/, "").replace(",", "."));
  if (!text.trim() || !Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
  // Round at four decimals of rate (0.01%) to keep float noise out of the stored value.
  return Math.round(percent * 100) / 10000;
}

const BLANK_OFFER = { name: "", payoutType: "percentage" as PayoutType, payoutText: "20", currency: "USD", windowDays: 30 };

// The enums the programs route accepts (`routes/programs.ts`). The attribution values used
// to be "last_click" / "first_click", which the API rejects — creating a program always failed.
const APPROVAL_MODES: { value: string; label: string }[] = [
  { value: "manual", label: "manual — you approve each applicant" },
  { value: "auto", label: "auto — applicants are approved instantly" },
  { value: "invite_only", label: "invite only — no public applications" },
];
const ATTRIBUTION: { value: string; label: string }[] = [
  { value: "last_touch", label: "last touch — the most recent link or code wins" },
  { value: "link_first", label: "link first — a tracked click beats a code" },
  { value: "code_first", label: "code first — a code beats a tracked click" },
];

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
    attributionPriority: "last_touch",
    holdDays: 30,
  });

  const [offerForm, setOfferForm] = useState(BLANK_OFFER);
  // Shown inside the open modal — an error on the page behind the overlay is invisible.
  const [formErr, setFormErr] = useState<string | null>(null);
  const offerPayout = payoutValueFrom(offerForm.payoutType, offerForm.payoutText);

  async function createProgram(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormErr(null);
    try {
      const created = await api.post<Program | null>("/programs", {
        name: progForm.name.trim(),
        approvalMode: progForm.approvalMode,
        defaultCurrency: progForm.defaultCurrency,
        attributionPriority: progForm.attributionPriority,
        holdDays: Math.round(Number(progForm.holdDays)) || 0,
      });
      setShowNewProgram(false);
      setProgForm({ name: "", approvalMode: "manual", defaultCurrency: "USD", attributionPriority: "last_touch", holdDays: 30 });
      programs.reload();
      if (created?.id) setSelectedId(created.id);
    } catch (e) {
      setFormErr(errorMessage(e, "Failed to create program"));
    } finally {
      setBusy(false);
    }
  }

  async function createOffer(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || offerPayout === null) return;
    setBusy(true);
    setFormErr(null);
    try {
      await api.post(`/programs/${selectedId}/offers`, {
        name: offerForm.name.trim(),
        engine: "affiliate",
        payoutType: offerForm.payoutType,
        payoutValue: offerPayout,
        currency: offerForm.currency,
        windowDays: Math.round(Number(offerForm.windowDays)) || 30,
        rules: [],
        tiers: [],
        bonuses: [],
        overridePolicy: null,
      });
      setShowNewOffer(false);
      setOfferForm(BLANK_OFFER);
      detail.reload();
    } catch (e) {
      setFormErr(errorMessage(e, "Failed to create offer"));
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
    } catch (e) {
      setErr(errorMessage(e, "Failed to update status"));
    }
  }

  if (programs.loading) return <Spinner />;
  if (programs.error) return <ErrorBanner message={programs.error} />;
  const items = programs.data ?? [];
  const active = items.filter((p) => p.status === "active").length;
  const selected = detail.data;
  const offers = selected?.offers ?? [];

  function openNewProgram() {
    setFormErr(null);
    setShowNewProgram(true);
  }
  function openNewOffer() {
    setFormErr(null);
    // A new offer starts in the program's currency rather than a hard-coded one.
    setOfferForm({ ...BLANK_OFFER, currency: selected?.defaultCurrency ?? BLANK_OFFER.currency });
    setShowNewOffer(true);
  }

  return (
    <>
      <PageHeader
        title="Programs & offers"
        crumb="PROGRAM DESIGN"
        subtitle="A program is the contract: approval rules, currency, attribution, and hold. Offers are the levers — what you pay, how, and for how long the attribution window stays open."
        actions={
          <button className="btn primary" onClick={openNewProgram}>
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
          action={<button className="btn primary" onClick={openNewProgram}>New program</button>}
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
                          {p.defaultCurrency ?? "—"} · {humanize(p.attributionPriority)}
                        </div>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>{humanize(p.approvalMode)}</td>
                      <td><Badge kind={statusKind(p.status)}>{p.status}</Badge></td>
                      <td className="num">{p.holdDays != null ? `${num(p.holdDays)}d` : "—"}</td>
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
                  <Badge kind="info">{humanize(selected.approvalMode)} approval</Badge>
                  {selected.defaultCurrency && <Badge>{selected.defaultCurrency}</Badge>}
                  <Badge>{humanize(selected.attributionPriority)}</Badge>
                  {selected.holdDays != null && <Badge kind="warn">{selected.holdDays}d hold</Badge>}
                </div>

                <div className="row between" style={{ marginBottom: 8 }}>
                  <div className="card-title" style={{ fontSize: 14 }}>Offers · {offers.length}</div>
                  <button className="btn sm" onClick={openNewOffer}>＋ Add offer</button>
                </div>

                {offers.length === 0 ? (
                  <EmptyState
                    title="No offers"
                    hint="Add an offer to define the payout — a percentage of order value or a flat amount per conversion — and the attribution window."
                    action={<button className="btn primary sm" onClick={openNewOffer}>Add offer</button>}
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
                      {offers.map((o) => (
                        <tr key={o.id}>
                          <td>
                            <div style={{ fontWeight: 600 }}>{o.name}</div>
                            <div className="faint mono" style={{ fontSize: 11 }}>{o.engine}</div>
                          </td>
                          <td className="muted" style={{ fontSize: 12 }}>{o.payoutType}</td>
                          <td className="num mono">{payoutDisplay(o)}</td>
                          <td className="num">{o.windowDays != null ? `${num(o.windowDays)}d` : "—"}</td>
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
          {formErr && <ErrorBanner message={formErr} />}
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
                {APPROVAL_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
            <Field label="Default currency">
              <input className="input" value={progForm.defaultCurrency} onChange={(e) => setProgForm({ ...progForm, defaultCurrency: e.target.value.toUpperCase() })} maxLength={3} required />
            </Field>
          </div>
          <div className="grid grid-2">
            <Field label="Attribution priority">
              <select className="select" value={progForm.attributionPriority} onChange={(e) => setProgForm({ ...progForm, attributionPriority: e.target.value })}>
                {ATTRIBUTION.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </Field>
            <Field label="Hold days (0–180)">
              <input className="input" type="number" min={0} max={180} step={1} value={progForm.holdDays} onChange={(e) => setProgForm({ ...progForm, holdDays: Number(e.target.value) })} required />
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
          {formErr && <ErrorBanner message={formErr} />}
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
                  const payoutType = e.target.value as PayoutType;
                  setOfferForm({ ...offerForm, payoutType, payoutText: payoutType === "percentage" ? "20" : "10.00" });
                }}
              >
                <option value="percentage">percentage of the order</option>
                <option value="flat">flat amount per conversion</option>
              </select>
            </Field>
            {/* Typed in human units; converted to the API's decimal rate / integer cents on submit. */}
            <Field label={offerForm.payoutType === "percentage" ? "Commission (%)" : `Amount per conversion (${offerForm.currency || "currency"})`}>
              <input
                className="input mono"
                inputMode="decimal"
                value={offerForm.payoutText}
                onChange={(e) => setOfferForm({ ...offerForm, payoutText: e.target.value })}
                placeholder={offerForm.payoutType === "percentage" ? "20" : "10.00"}
                aria-invalid={offerPayout === null}
                style={{ borderColor: offerPayout === null ? "var(--neg)" : undefined }}
                required
              />
            </Field>
          </div>
          <div className="grid grid-2">
            <Field label="Currency">
              <input className="input" value={offerForm.currency} onChange={(e) => setOfferForm({ ...offerForm, currency: e.target.value.toUpperCase() })} maxLength={3} minLength={3} required />
            </Field>
            <Field label="Attribution window (days, 1–365)">
              <input className="input" type="number" min={1} max={365} step={1} value={offerForm.windowDays} onChange={(e) => setOfferForm({ ...offerForm, windowDays: Number(e.target.value) })} required />
            </Field>
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            {offerPayout === null ? (
              <span className="neg">
                {offerForm.payoutType === "percentage" ? "Enter a percentage above 0 and up to 100, e.g. 20." : "Enter an amount above zero, e.g. 10.00."}
              </span>
            ) : (
              <>
                Engine: affiliate ·{" "}
                {offerForm.payoutType === "percentage" ? `pays ${pct(offerPayout)} of order value` : `pays ${money(offerPayout, offerForm.currency)} per conversion`}
              </>
            )}
          </div>
          <div className="row gap-8 mt-16">
            <button type="submit" className="btn primary" disabled={busy || !offerForm.name.trim() || offerPayout === null}>
              {busy ? "Adding…" : "Add offer"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setShowNewOffer(false)}>Cancel</button>
          </div>
        </form>
      </Modal>
    </>
  );
}
