import { useState } from "react";
import { api } from "../api";
import { Card, PageHeader, Field, Badge } from "../ui";

type FormType = "W-9" | "W-8BEN" | "W-8BEN-E" | "other";
type Rail = "stripe" | "paypal" | "wise";

const FORM_TYPES: { value: FormType; label: string }[] = [
  { value: "W-9", label: "W-9 — U.S. person / entity" },
  { value: "W-8BEN", label: "W-8BEN — non-U.S. individual" },
  { value: "W-8BEN-E", label: "W-8BEN-E — non-U.S. entity" },
  { value: "other", label: "Other / I'm not sure" },
];

// Merchants pay affiliates directly from their own account, so what matters here is that
// the reference is something a person can actually pay to.
const RAILS: { value: Rail; label: string; hint: string }[] = [
  { value: "paypal", label: "PayPal", hint: "the email on your PayPal account" },
  { value: "wise", label: "Wise", hint: "the email on your Wise account, or your IBAN / account details" },
  { value: "stripe", label: "Stripe", hint: "your Stripe account ID — only useful if the merchant pays through Stripe" },
];

function SuccessBanner({ message }: { message: string }) {
  return (
    <div
      className="err-banner"
      style={{ background: "var(--acc-glow)", borderColor: "var(--acc-dim)", color: "var(--acc)" }}
    >
      {message}
    </div>
  );
}

export function PortalSettings() {
  const [formType, setFormType] = useState<FormType>("W-9");
  const [taxBusy, setTaxBusy] = useState(false);
  const [taxMsg, setTaxMsg] = useState<string | null>(null);
  const [taxErr, setTaxErr] = useState<string | null>(null);

  const [rail, setRail] = useState<Rail>("paypal");
  const [accountRef, setAccountRef] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutMsg, setPayoutMsg] = useState<string | null>(null);
  const [payoutErr, setPayoutErr] = useState<string | null>(null);

  async function submitTax(e: React.FormEvent) {
    e.preventDefault();
    setTaxBusy(true);
    setTaxMsg(null);
    setTaxErr(null);
    try {
      await api.post("/portal/tax-document", { formType });
      setTaxMsg(`${formType} self-certification recorded. Your payout hold for missing tax info is now cleared.`);
    } catch (err: any) {
      setTaxErr(err?.message ?? "Could not submit tax form.");
    } finally {
      setTaxBusy(false);
    }
  }

  async function submitPayout(e: React.FormEvent) {
    e.preventDefault();
    if (!accountRef.trim()) {
      setPayoutErr("Enter the account reference for your chosen rail.");
      return;
    }
    setPayoutBusy(true);
    setPayoutMsg(null);
    setPayoutErr(null);
    try {
      const cur = currency.trim().toUpperCase();
      await api.post("/portal/payout-account", { rail, accountRef: accountRef.trim(), currency: cur });
      setPayoutMsg(`Payout details saved — ${rail} → ${accountRef.trim()} in ${cur}. Merchants will pay you here.`);
    } catch (err: any) {
      setPayoutErr(err?.message ?? "Could not save payout account.");
    } finally {
      setPayoutBusy(false);
    }
  }

  const railHint = RAILS.find((r) => r.value === rail)?.hint;

  return (
    <>
      <PageHeader
        title="Payout & tax setup"
        crumb="PORTAL · SETTINGS"
        subtitle="Two things stand between your earnings and your bank: a tax form on file and payout details. Both live here. Merchants pay you directly from their own account, and they can't include you in a payout until both are set — so do this once."
      />

      <div className="grid grid-2">
        <Card title="Tax form" sub="self-certification — required before any payout is released">
          <form onSubmit={submitTax} className="mt-16">
            <Field label="Which form applies to you?">
              <select className="select" value={formType} onChange={(e) => setFormType(e.target.value as FormType)}>
                {FORM_TYPES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="card" style={{ background: "var(--ink-850)", padding: 14, marginTop: 4, marginBottom: 16 }}>
              <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
                By submitting, you certify <strong className="acc">under penalty of perjury</strong> that the information on
                the selected form is true, correct, and complete, and that the form type matches your tax status. We keep
                this certification on file to satisfy reporting requirements.
              </div>
              <div className="row gap-8 mt-16">
                <Badge kind="warn">payout gated on a form being on file</Badge>
              </div>
            </div>

            {taxMsg && <SuccessBanner message={taxMsg} />}
            {taxErr && <div className="err-banner">{taxErr}</div>}

            <div className="row gap-8 mt-16">
              <button className="btn primary" type="submit" disabled={taxBusy}>
                {taxBusy ? "submitting…" : "Submit & certify"}
              </button>
            </div>
          </form>
        </Card>

        <Card title="Payout details" sub="where merchants send your commissions">
          <form onSubmit={submitPayout} className="mt-16">
            <Field label="How you want to be paid">
              <select className="select" value={rail} onChange={(e) => setRail(e.target.value as Rail)}>
                {RAILS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Account reference">
              <input
                className="input"
                value={accountRef}
                onChange={(e) => setAccountRef(e.target.value)}
                placeholder={rail === "paypal" ? "you@example.com" : "account / token / IBAN"}
                autoComplete="off"
              />
            </Field>
            {railHint && (
              <div className="faint" style={{ fontSize: 11, marginTop: -8, marginBottom: 12 }}>
                {rail} — {railHint}
              </div>
            )}

            <Field label="Settlement currency">
              <input
                className="input mono"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                placeholder="USD"
                maxLength={3}
                style={{ maxWidth: 140 }}
                autoComplete="off"
              />
            </Field>

            {payoutMsg && <SuccessBanner message={payoutMsg} />}
            {payoutErr && <div className="err-banner">{payoutErr}</div>}

            <div className="row gap-8 mt-16">
              <button className="btn primary" type="submit" disabled={payoutBusy}>
                {payoutBusy ? "saving…" : "Save payout account"}
              </button>
            </div>
          </form>
        </Card>
      </div>

      <div className="mt-24">
        <Card title="How payouts release" sub="both gates must be green before money moves">
          <div className="grid grid-3 mt-16">
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">1 · Certify tax status</strong>
              <p style={{ marginTop: 4 }}>
                Submit the form that matches your residency and entity type. The certification clears the tax hold on
                your balance.
              </p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">2 · Save your payout details</strong>
              <p style={{ marginTop: 4 }}>
                Pick how you want to be paid and give the details a merchant needs — your PayPal email, or your Wise
                account. This is exactly what they will pay to, so double-check it.
              </p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">3 · The merchant pays you</strong>
              <p style={{ marginTop: 4 }}>
                Once both are on file and your balance clears a merchant's minimum, they include you in their next payout
                batch and pay you directly from their own account. It appears under Payouts.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
