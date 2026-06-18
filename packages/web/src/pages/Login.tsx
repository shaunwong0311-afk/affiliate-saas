import { useState } from "react";
import { useAuth } from "../auth";
import { Field, ErrorBanner } from "../ui";

type Mode = "login" | "signup" | "affiliate";

export function Login() {
  const { login, signup, affiliateLogin } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ email: "", password: "", name: "", merchantName: "", niche: "" });

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(form.email, form.password);
      else if (mode === "signup") await signup(form);
      else await affiliateLogin(form.email);
    } catch (err: any) {
      setError(err?.message ?? "failed");
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
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Sign in
          </button>
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
            New merchant
          </button>
          <button type="button" className={mode === "affiliate" ? "active" : ""} onClick={() => setMode("affiliate")}>
            Affiliate
          </button>
        </div>

        {error && <ErrorBanner message={error} />}

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
          <input className="input" type="email" value={form.email} onChange={set("email")} required />
        </Field>

        {mode !== "affiliate" && (
          <Field label="Password">
            <input className="input" type="password" value={form.password} onChange={set("password")} required minLength={8} />
          </Field>
        )}

        <button className="btn primary" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : mode === "signup" ? "Create program" : "Enter portal"}
        </button>

        <p className="faint" style={{ fontSize: 12, textAlign: "center", marginTop: 18, marginBottom: 0 }}>
          {mode === "affiliate"
            ? "Affiliates enter with the email on file (magic-link in production)."
            : "Tracking is table stakes — Vantage helps you find affiliates."}
        </p>
      </form>
    </div>
  );
}
