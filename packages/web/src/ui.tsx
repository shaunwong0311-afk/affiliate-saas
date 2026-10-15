import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** HTTP status of the failed request (0 = no response), or null when there is no error.
   *  Lets a page tell "you may not see this" (403) apart from "something broke". */
  errorStatus: number | null;
  reload: () => void;
}

/**
 * Data-fetch hook with loading/error/reload — the page workhorse.
 *
 * Only the LATEST request may write state. Without that guard a slow response for an
 * old filter (or the previous record) lands after the fresh one and silently replaces
 * it — the list on screen no longer matches the filter above it. Responses that arrive
 * after the component unmounted are dropped the same way.
 */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  // Monotonic request id; bumping it invalidates every request still in flight.
  const latest = useRef(0);

  const run = useCallback(() => {
    const id = ++latest.current;
    const current = () => latest.current === id;
    setLoading(true);
    setError(null);
    setErrorStatus(null);
    let pending: Promise<T>;
    try {
      pending = fn();
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending
      .then((d) => {
        if (current()) setData(d);
      })
      .catch((e) => {
        if (!current()) return;
        setError(typeof e?.message === "string" && e.message ? e.message : "request failed");
        setErrorStatus(typeof e?.status === "number" ? e.status : null);
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
    // Unmount, or the deps changed: whatever is in flight is now stale.
    return () => {
      latest.current++;
    };
  }, [run]);

  return { data, loading, error, errorStatus, reload: run };
}

export function Card({ title, sub, actions, children, flush }: { title?: string; sub?: string; actions?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <div className={`card${flush ? " flush" : ""}`}>
      {(title || actions) && (
        <div className="card-head" style={flush ? { padding: "18px 20px 0" } : undefined}>
          <div>
            {title && <div className="card-title">{title}</div>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value, foot, footClass, small }: { label: string; value: ReactNode; foot?: ReactNode; footClass?: string; small?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${small ? " sm" : ""} mono`}>{value}</div>
      {foot && <div className={`stat-foot ${footClass ?? ""}`}>{foot}</div>}
    </div>
  );
}

export function Badge({ children, kind }: { children: ReactNode; kind?: string }) {
  return <span className={`badge ${kind ?? ""}`}>{children}</span>;
}

const STATUS_KIND: Record<string, string> = {
  active: "pos", approved: "pos", paid: "pos", connected: "pos", verified: "pos", sent: "pos",
  ready: "pos", delivered: "pos", done: "pos", on_file: "pos", cleared: "pos",
  pending: "warn", processing: "warn", draft: "", flagged: "warn", warming: "warn", trialing: "info",
  paused: "warn", held: "warn", queued: "info", invited: "info", open: "info",
  // A payout the merchant has approved and now has to pay from their own account.
  awaiting_payment: "warn", past_due: "warn",
  rejected: "neg", reversed: "neg", failed: "neg", banned: "neg", bounced: "neg", suppressed: "neg", error: "neg",
  disabled: "neg", disconnected: "neg", cancelled: "neg", canceled: "neg",
};

/** Badge colour for a status string. Unknown (or missing) statuses render neutral. */
export function statusKind(status: string | null | undefined): string {
  // Own-property lookup: a status that happens to be "constructor" must not hit Object.prototype.
  return status != null && Object.prototype.hasOwnProperty.call(STATUS_KIND, status) ? STATUS_KIND[status]! : "";
}

/**
 * A URL that is safe to put in an `href`, or undefined. Prospect evidence, creator
 * profiles and contact pages are scraped from the open web (or imported), so a link there
 * can be anything — including `javascript:`, which would run in the operator's session
 * when clicked. Only http(s) survives; anything else renders as plain text.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (typeof url !== "string") return undefined;
  const trimmed = url.trim();
  // Must literally start with the scheme: browsers ignore whitespace and control characters
  // inside a scheme ("java\tscript:"), so parsing-then-checking is the wrong way round.
  return /^https?:\/\/[^\s]+$/i.test(trimmed) ? trimmed : undefined;
}

/** "awaiting_payment" → "awaiting payment". Safe on a missing value. */
export function humanize(value: string | null | undefined, fallback = "—"): string {
  if (value == null || value === "") return fallback;
  return String(value).replace(/_/g, " ");
}

export function Spinner({ label }: { label?: string }) {
  return <div className="loading-screen">{label ?? "loading…"}</div>;
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="big">{title}</div>
      {hint && <div>{hint}</div>}
      {action && <div className="mt-16">{action}</div>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="err-banner">{message}</div>;
}

/** A non-error banner: `ok` for a completed action, `warn` for something to act on, `info` for context. */
export function Notice({ kind = "ok", children, style }: { kind?: "ok" | "warn" | "info"; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className={`notice ${kind}`} role="status" style={style}>
      {children}
    </div>
  );
}

export function PageHeader({ title, crumb, subtitle, actions }: { title: string; crumb?: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="section-head">
      <div>
        {crumb && <div className="crumb mono" style={{ fontSize: 12, color: "var(--text-faint)", marginBottom: 4 }}>{crumb}</div>}
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row gap-8">{actions}</div>}
    </div>
  );
}

/** A lightweight modal/drawer. Escape closes it; the body scrolls when it outgrows the viewport. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50, display: "grid", placeItems: "center", padding: 20, overflowY: "auto" }}
      onClick={onClose}
    >
      <div className="card" role="dialog" aria-modal="true" aria-label={title} style={{ width: "100%", maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="card-title">{title}</div>
          <button type="button" className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
