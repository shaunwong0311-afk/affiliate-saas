import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAuth } from "../auth";
import { errorMessage, errorStatus } from "../api";
import { hashParam, navigate } from "../router";
import { ErrorBanner, Field, Notice } from "../ui";

/**
 * PUBLIC landing page for the emailed affiliate sign-in link:
 * `{app}/#/portal/verify?token=…` (the "request a link" email and the activation/welcome
 * email both use it). Renders outside the authenticated shell — the visitor has no session
 * yet. It exchanges the one-time token for a portal session and lands on `/portal`.
 *
 * Links are single-use and short-lived, so the failure path matters as much as the happy
 * one: a spent link explains itself and offers a new one on the spot.
 */

type Phase =
  | { kind: "verifying" }
  /** The link carried no token (truncated when copied, or opened without the query). */
  | { kind: "missing" }
  /** Used already, expired, or simply not a valid link — the API does not say which. */
  | { kind: "spent" }
  /** Rate limited. The link itself is untouched. */
  | { kind: "throttled" }
  /** No answer, or a server error: the link may well still be good. */
  | { kind: "unreachable"; detail: string };

function classify(e: unknown): Phase {
  const status = errorStatus(e);
  if (status === 429) return { kind: "throttled" };
  if (status === null || status === 0 || status >= 500) return { kind: "unreachable", detail: errorMessage(e, "no response") };
  return { kind: "spent" };
}

export function PortalVerify() {
  const { me, isAffiliate, completeAffiliateLogin } = useAuth();
  // Read once: the hash is replaced on success, and a re-render must not re-read it.
  const [token] = useState(() => (hashParam("token") ?? "").trim());
  const [phase, setPhase] = useState<Phase>(token ? { kind: "verifying" } : { kind: "missing" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setPhase({ kind: "verifying" });
    // completeAffiliateLogin de-duplicates per token, so React StrictMode running this
    // effect twice (or a quick remount) still spends the one-time link exactly once.
    completeAffiliateLogin(token).then(
      () => {
        // Replace, don't push: Back must not return to a link that is now spent.
        if (!cancelled) navigate("/portal", { replace: true });
      },
      (e) => {
        if (!cancelled) setPhase(classify(e));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, attempt]);

  const signedInName = isAffiliate ? me?.affiliate?.name ?? me?.affiliate?.primaryEmail ?? "your account" : null;

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand">
          <div className="brand-mark">V</div>
          <div className="brand-name">
            Vantage
            <small>affiliate portal</small>
          </div>
        </div>

        {phase.kind === "verifying" && (
          <div role="status" style={{ textAlign: "center", padding: "6px 0 4px" }}>
            <div className="pulse-dot" aria-hidden />
            <h3 style={{ fontSize: 17, marginTop: 14 }}>Signing you in…</h3>
            <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>
              Checking your one-time link. This only takes a moment.
            </p>
          </div>
        )}

        {phase.kind === "unreachable" && (
          <Outcome title="We couldn't check your sign-in link">
            <p>
              The server didn't answer, so your link has most likely <strong>not</strong> been used up. Check your connection
              and try again.
            </p>
            <div className="faint mono" style={{ fontSize: 11.5, marginBottom: 16 }}>{phase.detail}</div>
            <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => setAttempt((n) => n + 1)}>
              ↻ Try again
            </button>
            <NewLink intro="Still stuck? Get a fresh link instead:" />
          </Outcome>
        )}

        {phase.kind === "throttled" && (
          <Outcome title="Too many attempts">
            <p>Sign-in is briefly paused for this connection. Wait a minute, then try your link again — it hasn't been used up.</p>
            <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} onClick={() => setAttempt((n) => n + 1)}>
              ↻ Try again
            </button>
          </Outcome>
        )}

        {(phase.kind === "spent" || phase.kind === "missing") && (
          <Outcome title={phase.kind === "spent" ? "This sign-in link can't be used" : "This sign-in link is incomplete"}>
            {phase.kind === "spent" ? (
              <p>
                Sign-in links work <strong>once</strong> and expire after a short time. This one has already been used or has
                expired.
              </p>
            ) : (
              <p>The link is missing its sign-in code — it may have been cut off when it was copied or forwarded.</p>
            )}
            {signedInName && (
              <Notice kind="ok" style={{ textAlign: "left" }}>
                You're already signed in as <strong>{signedInName}</strong>.{" "}
                <a
                  href="#/portal"
                  style={{ textDecoration: "underline" }}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate("/portal", { replace: true });
                  }}
                >
                  Continue to your portal →
                </a>
              </Notice>
            )}
            <NewLink intro={signedInName ? "Signing in as someone else? Send a link to that address:" : "Enter the email you signed up with and we'll send a new one."} />
          </Outcome>
        )}

        <p className="faint" style={{ fontSize: 12, textAlign: "center", marginTop: 20, marginBottom: 0 }}>
          Running a program rather than promoting one?{" "}
          <a href="#/login" style={{ textDecoration: "underline" }}>
            Merchant sign-in
          </a>
        </p>
      </div>
    </div>
  );
}

function Outcome({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="verify-outcome">
      <h3 style={{ fontSize: 17, textAlign: "center" }}>{title}</h3>
      <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 10 }}>
        {children}
      </div>
    </div>
  );
}

/** "Send me a new link" — `POST /auth/affiliate/request-link` via the auth context. */
function NewLink({ intro }: { intro: string }) {
  const { affiliateLogin } = useAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    setSentTo(null);
    try {
      const result = await affiliateLogin(address);
      // Outside production the API returns the token directly and we are signed in already.
      if (result === "signed_in") navigate("/portal", { replace: true });
      else setSentTo(address);
    } catch (err) {
      const status = errorStatus(err);
      if (status === 429) setError("Too many requests from this connection. Wait a minute and try again.");
      else if (status === 400) setError("That doesn't look like a valid email address.");
      else setError(errorMessage(err, "Could not send a new link. Try again."));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <Notice kind="ok" style={{ marginTop: 18, textAlign: "left" }}>
        If <strong>{sentTo}</strong> belongs to an affiliate account, a new sign-in link is on its way. It works once and
        expires shortly, so open the newest email — and check spam if it hasn't arrived in a couple of minutes.{" "}
        <a
          href="#"
          style={{ textDecoration: "underline" }}
          onClick={(e) => {
            e.preventDefault();
            setSentTo(null);
          }}
        >
          Use a different address
        </a>
      </Notice>
    );
  }

  return (
    <form onSubmit={submit} style={{ marginTop: 18, textAlign: "left" }}>
      <p style={{ margin: "0 0 10px" }}>{intro}</p>
      {error && <ErrorBanner message={error} />}
      <Field label="Email">
        <input className="input" type="email" required autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy || !email.trim()}>
        {busy ? "sending…" : "Send me a new link"}
      </button>
    </form>
  );
}
