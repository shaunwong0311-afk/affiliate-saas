import { useState } from "react";
import { useAuth } from "../auth";
import { errorMessage, errorStatus } from "../api";
import { Field, ErrorBanner, Notice } from "../ui";

type Mode = "login" | "signup" | "affiliate";

export function Login({ initialMode = "login" }: { initialMode?: Mode }) {
  const { login, signup, affiliateLogin } = useAuth();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [error, setError] = useState<string | null>(null);
  // The address a sign-in link was just sent to (affiliate tab, production path).
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", name: "", merchantName: "", niche: "" });

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setLinkSentTo(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLinkSentTo(null);
    setBusy(true);
    try {
      if (mode === "login") await login(form.email, form.password);
      else if (mode === "signup") await signup(form);
      else {
        // In production this emails a one-time link (opened at #/portal/verify). Outside
        // production the API returns the token and the session starts immediately.
        const result = await affiliateLogin(form.email.trim());
        if (result === "link_sent") setLinkSentTo(form.email.trim());
      }
    } catch (err) {
      if (errorStatus(err) === 429) setError("Too many attempts from this connection. Wait a minute and try again.");
      else setError(errorMessage(err, "Sign-in failed. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <div className="brand-mark">V</div>
          <div className="brand-name">
            Vantage
            <small>recruitment os</small>
          </div>
        </div>

        <div className="auth-tabs">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")}>
            Sign in
          </button>
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => switchMode("signup")}>
            New merchant
          </button>
          <button type="button" className={mode === "affiliate" ? "active" : ""} onClick={() => switchMode("affiliate")}>
            Affiliate
          </button>
        </div>

        {error && <ErrorBanner message={error} />}
        {linkSentTo && (
          <Notice kind="ok">
            If <strong>{linkSentTo}</strong> belongs to an affiliate account, a sign-in link is on its way. It works once and
            expires shortly — open the newest email on this device, and check spam if it hasn't arrived in a couple of minutes.
          </Notice>
        )}

        {mode === "signup" && (
          <>
            <Field label="Your name">
              <input className="input" value={form.name} onChange={set("name")} required />
            </Field>
            <Field label="Company / store name">
              <input className="input" value={form.merchantName} onChange={set("merchantName")} required />
            </Field>
            <Field label="Niche (e.g. skincare, SaaS, fitness)">
              <input className="input" value={form.niche} onChange={set("niche")} placeholder="optional" />
            </Field>
          </>
        )}

        <Field label="Email">
          <input className="input" type="email" autoComplete="email" value={form.email} onChange={set("email")} required />
        </Field>

        {mode !== "affiliate" && (
          <Field label="Password">
            <input
              className="input"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={form.password}
              onChange={set("password")}
              required
              minLength={8}
            />
          </Field>
        )}

        <button className="btn primary" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : mode === "signup" ? "Create program" : linkSentTo ? "Send another link" : "Email me a sign-in link"}
        </button>

        <p className="faint" style={{ fontSize: 12, textAlign: "center", marginTop: 18, marginBottom: 0 }}>
          {mode === "affiliate"
            ? "Affiliates sign in without a password: we email a one-time link to the address on file."
            : "Tracking is table stakes — Vantage helps you find affiliates."}
        </p>
      </form>
    </div>
  );
}
