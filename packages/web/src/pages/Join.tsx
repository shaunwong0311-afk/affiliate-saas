import { useState } from "react";
import { api } from "../api";

interface JoinResult {
  affiliateId: string;
  relationshipId: string;
  status: "active" | "pending";
  created: boolean;
}

/**
 * PUBLIC self-serve "apply to join the program" page — the link the AI-SDR and the
 * activation emails hand out. Renders outside the authenticated app shell (no sidebar,
 * no session). Auto-approval programs activate instantly; manual programs land pending.
 */
export function Join({ merchantId }: { merchantId: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [socialUrl, setSocialUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<JoinResult>(`/join/${merchantId}`, { name, email, socialUrl: socialUrl.trim() || undefined });
      setResult(r);
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="card" style={{ width: "100%", maxWidth: 440 }}>
        <div className="card-head">
          <div>
            <div className="card-title">Join the affiliate program</div>
            <div className="card-sub">get your tracking link + personal code in minutes</div>
          </div>
        </div>

        {result ? (
          <div style={{ padding: "8px 0" }}>
            {result.status === "active" ? (
              <>
                <p style={{ fontSize: 15 }}>
                  🎉 <strong>You're in!</strong> Your application was approved instantly.
                </p>
                <p className="muted" style={{ fontSize: 13 }}>
                  Check <span className="mono">{email}</span> for your welcome email — it has your one-click portal sign-in, your tracking link, and your personal code. (You can also request a sign-in link any time from the portal login page.)
                </p>
              </>
            ) : (
              <>
                <p style={{ fontSize: 15 }}>
                  ✓ <strong>Application received.</strong>
                </p>
                <p className="muted" style={{ fontSize: 13 }}>
                  The team reviews applications personally — once you're approved you'll get an email at <span className="mono">{email}</span> with everything you need to start earning.
                </p>
              </>
            )}
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="field">
              <label>Your name</label>
              <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jamie Creator" />
            </div>
            <div className="field">
              <label>Email</label>
              <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <div className="field">
              <label>Your site or main channel (optional)</label>
              <input className="input" value={socialUrl} onChange={(e) => setSocialUrl(e.target.value)} placeholder="https://instagram.com/you" />
            </div>
            {error && <div className="err-banner">{error}</div>}
            <button className="btn primary" style={{ width: "100%", marginTop: 8 }} disabled={busy}>
              {busy ? "Submitting…" : "Apply to join"}
            </button>
            <p className="faint" style={{ fontSize: 11, marginTop: 10 }}>
              Free to join. You earn a commission on every sale you drive; payouts and stats live in your own portal.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
