import { useState } from "react";
import { api, errorMessage, errorStatus } from "../api";
import { hashParam } from "../router";

interface JoinResult {
  affiliateId?: string;
  relationshipId?: string;
  status?: "active" | "pending" | (string & {});
  created?: boolean;
}

/** "instagram.com/you" → "https://instagram.com/you" — the API validates this as a full URL. */
function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, "")}`;
}

/**
 * PUBLIC self-serve "apply to join the program" page — the link the AI-SDR and the
 * activation emails hand out. Renders outside the authenticated app shell (no sidebar,
 * no session). Auto-approval programs activate instantly; manual programs land pending.
 *
 * The link a recruited creator receives is `#/join/<merchantId>?p=<prospectId>`. That
 * `p` is what ties the new affiliate back to the prospect (and so to the source that
 * found them), so it is read here and sent with the application as `prospectId`.
 */
export function Join({ merchantId }: { merchantId: string }) {
  // Read once on mount: the id identifies who was invited, not something to re-read.
  const [prospectId] = useState(() => (hashParam("p") ?? "").trim() || null);
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
      const social = socialUrl.trim();
      const r = await api.post<JoinResult | null>(`/join/${encodeURIComponent(merchantId)}`, {
        name: name.trim(),
        email: email.trim(),
        socialUrl: social ? withScheme(social) : undefined,
        // Recruitment attribution (see the note above). Omitted for organic applicants.
        prospectId: prospectId ?? undefined,
      });
      setResult(r ?? {});
    } catch (err) {
      const status = errorStatus(err);
      if (status === 404) setError("This program isn't accepting applications at this link. Check the link you were sent.");
      else if (status === 429) setError("Too many attempts from this connection. Wait a minute and try again.");
      else if (status === 400) setError(`Please check your details: ${errorMessage(err, "something was not valid").replace(/^validation:\s*/i, "")}`);
      else setError(errorMessage(err, "Something went wrong — please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, position: "relative", zIndex: 2 }}>
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
                  Check <span className="mono">{email}</span> for your welcome email — it has your one-click portal sign-in, your tracking link, and your personal code. (You can also{" "}
                  <a href="#/portal" style={{ textDecoration: "underline" }}>request a sign-in link</a> any time.)
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
              <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jamie Creator" autoComplete="name" />
            </div>
            <div className="field">
              <label>Email</label>
              <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
            </div>
            <div className="field">
              <label>Your site or main channel (optional)</label>
              <input className="input" value={socialUrl} onChange={(e) => setSocialUrl(e.target.value)} placeholder="https://instagram.com/you" />
            </div>
            {error && <div className="err-banner">{error}</div>}
            <button className="btn primary" style={{ width: "100%", marginTop: 8, justifyContent: "center" }} disabled={busy}>
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
