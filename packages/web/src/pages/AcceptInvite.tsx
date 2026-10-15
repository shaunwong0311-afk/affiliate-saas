import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { ApiError, errorMessage, errorStatus } from "../api";
import { hashParam, navigate } from "../router";
import { ErrorBanner, Field, Notice } from "../ui";

/**
 * PUBLIC landing page for an emailed team invitation: `{app}/#/accept-invite?token=…`.
 * Renders outside the authenticated shell.
 *
 * The invitation token is single-use and is the ONLY thing that can accept an invite — a bare
 * email no longer can (anyone who knew an invited address could otherwise set its password).
 * Two cases, decided by the API:
 *  - a new account: the invitee chooses a password here;
 *  - an address that already has an account: they must be signed in as that account, so the
 *    role goes to whoever owns the inbox, not to whoever registered the address first.
 */
type Phase = "form" | "working" | "needs-sign-in" | "invalid" | "throttled";

export function AcceptInvite() {
  const { me, isAffiliate, acceptInvite, logout } = useAuth();
  // Read once: the hash is replaced on success, and a re-render must not re-read it.
  const [token] = useState(() => (hashParam("token") ?? "").trim());
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>(token ? "form" : "invalid");
  const [error, setError] = useState<string | null>(null);
  const signedInAs = me && !isAffiliate ? me.user?.email ?? me.user?.name ?? "your account" : null;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    setPhase("working");
    try {
      // Signed in: accept as that account (no password is sent). Otherwise: a new account.
      await acceptInvite(token, signedInAs ? undefined : password);
      // Replace, don't push: Back must not return to a link that is now spent.
      navigate("/dashboard", { replace: true });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const status = errorStatus(err);
      if (code === "sign_in_required") setPhase("needs-sign-in");
      else if (code === "password_required") {
        setPhase("form");
        setError("Choose a password of at least 8 characters to finish setting up your account.");
      } else if (status === 429) setPhase("throttled");
      else if (status === null || status === 0 || status >= 500) {
        // The link has most likely not been used up — let them try again.
        setPhase("form");
        setError(errorMessage(err, "The server did not answer. Your invitation has not been used — try again."));
      } else setPhase("invalid");
    }
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand">
          <div className="brand-mark">V</div>
          <div className="brand-name">
            Vantage
            <small>team invitation</small>
          </div>
        </div>

        {(phase === "form" || phase === "working") && (
          <form onSubmit={submit}>
            <h3 style={{ fontSize: 17, marginTop: 6 }}>Accept your invitation</h3>
            {signedInAs ? (
              <p className="muted" style={{ fontSize: 13, margin: "8px 0 16px" }}>
                You are signed in as <strong>{signedInAs}</strong>. Accepting adds this workspace to that account.
              </p>
            ) : (
              <>
                <p className="muted" style={{ fontSize: 13, margin: "8px 0 16px" }}>
                  Choose a password to create your account and join the workspace.
                </p>
                <Field label="Password">
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(ev) => setPassword(ev.target.value)}
                    minLength={8}
                    required
                  />
                </Field>
              </>
            )}
            {error && <ErrorBanner message={error} />}
            <button className="btn primary" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} disabled={phase === "working"}>
              {phase === "working" ? "accepting…" : "Accept invitation"}
            </button>
            {signedInAs && (
              <p className="faint" style={{ fontSize: 12, marginTop: 12 }}>
                Not you?{" "}
                <a className="acc" href="#" onClick={(ev) => { ev.preventDefault(); logout(); }}>
                  Sign out
                </a>{" "}
                and open the invitation link again.
              </p>
            )}
          </form>
        )}

        {phase === "needs-sign-in" && (
          <div>
            <h3 style={{ fontSize: 17, marginTop: 6 }}>Sign in to accept</h3>
            <Notice kind="info" style={{ margin: "12px 0 16px" }}>
              This email address already has an account. Sign in to it, then open the invitation link from your email again —
              the invitation has not been used.
            </Notice>
            <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => navigate("/login")}>
              Go to sign in
            </button>
          </div>
        )}

        {phase === "throttled" && (
          <div>
            <h3 style={{ fontSize: 17, marginTop: 6 }}>Too many attempts</h3>
            <p className="muted" style={{ fontSize: 13, margin: "8px 0 16px" }}>
              Wait a minute, then try again — your invitation has not been used.
            </p>
            <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => setPhase("form")}>
              ↻ Try again
            </button>
          </div>
        )}

        {phase === "invalid" && (
          <div>
            <h3 style={{ fontSize: 17, marginTop: 6 }}>This invitation can't be used</h3>
            <p className="muted" style={{ fontSize: 13, margin: "8px 0 16px" }}>
              It may have been used already, expired, or been copied incompletely. Ask the person who invited you to send a
              new one from Settings → Team.
            </p>
            <button className="btn" style={{ width: "100%", justifyContent: "center" }} onClick={() => navigate("/login")}>
              Go to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
