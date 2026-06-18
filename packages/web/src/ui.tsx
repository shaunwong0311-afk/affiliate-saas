import { useCallback, useEffect, useState, type ReactNode } from "react";

/** Data-fetch hook with loading/error/reload — the page workhorse. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    fn()
      .then((d) => setData(d))
      .catch((e) => setError(e?.message ?? "request failed"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => run(), [run]);
  return { data, loading, error, reload: run };
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

export function statusKind(status: string): string {
  const map: Record<string, string> = {
    active: "pos", approved: "pos", paid: "pos", connected: "pos", verified: "pos", sent: "pos",
    pending: "warn", processing: "warn", draft: "", flagged: "warn", warming: "warn", trialing: "info",
    paused: "warn", held: "warn", queued: "info",
    rejected: "neg", reversed: "neg", failed: "neg", banned: "neg", bounced: "neg", suppressed: "neg", error: "neg",
  };
  return map[status] ?? "";
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

/** A lightweight modal/drawer. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50, display: "grid", placeItems: "center", padding: 20 }}
      onClick={onClose}
    >
      <div className="card" style={{ width: "100%", maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <div className="card-title">{title}</div>
          <button className="btn ghost sm" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
