import { api, pct, num } from "../api";
import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, EmptyState } from "../ui";
import { navigate } from "../router";

interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  hint: string;
}

interface Checklist {
  items: ChecklistItem[];
  completed: number;
  total: number;
  percentComplete: number;
}

/** Route an incomplete item to the page where it gets resolved. */
const DESTINATIONS: Record<string, { to: string; cta: string }> = {
  program: { to: "/programs", cta: "Set up program →" },
  programs: { to: "/programs", cta: "Set up program →" },
  integration: { to: "/integrations", cta: "Connect →" },
  integrations: { to: "/integrations", cta: "Connect →" },
  tracking: { to: "/integrations", cta: "Connect →" },
  affiliate: { to: "/affiliates", cta: "Add affiliates →" },
  affiliates: { to: "/affiliates", cta: "Add affiliates →" },
  recruitment: { to: "/recruitment", cta: "Find affiliates →" },
  recruit: { to: "/recruitment", cta: "Find affiliates →" },
  prospects: { to: "/recruitment", cta: "Find affiliates →" },
};

function destinationFor(key: string): { to: string; cta: string } | null {
  if (DESTINATIONS[key]) return DESTINATIONS[key];
  const hit = Object.keys(DESTINATIONS).find((k) => key.toLowerCase().includes(k));
  return hit ? DESTINATIONS[hit] : null;
}

export function Onboarding() {
  const { data, loading, error, reload } = useApi<Checklist>(() => api.get("/onboarding/checklist"));

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return null;

  const { items, completed, total, percentComplete } = data;
  const allDone = total > 0 && completed >= total;

  return (
    <>
      <PageHeader
        title="Launch checklist"
        crumb="GET LIVE"
        subtitle="Programs fail when setup is left half-done — tracking with no offer, an offer with no affiliates. Close every gap below before you start recruiting at scale."
        actions={
          <button className="btn ghost" onClick={reload}>
            ↻ Refresh
          </button>
        }
      />

      <div className="grid grid-3">
        <Stat
          label="Setup progress"
          value={pct(percentComplete)}
          foot={`${num(completed)} of ${num(total)} complete`}
          footClass={allDone ? "pos" : "muted"}
        />
        <Stat label="Steps remaining" value={num(Math.max(0, total - completed))} small foot="until you're fully live" footClass="muted" />
        <Stat label="Steps done" value={num(completed)} small foot={`${num(total)} total`} footClass="muted" />
      </div>

      <div className="funnel-step" style={{ marginTop: 20, marginBottom: 4 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>completion</span>
        <div className="funnel-bar" style={{ width: `${Math.max(6, Math.round(percentComplete * 100))}%` }}>
          {pct(percentComplete)}
        </div>
        <span />
      </div>

      <div className="mt-24">
        <Card flush title="Launch steps" sub="every box is a place programs commonly stall">
          {items.length === 0 ? (
            <EmptyState title="No checklist items" hint="Your launch checklist will populate as the platform detects what's left to configure." />
          ) : (
            <div style={{ padding: "8px 4px 16px" }}>
              {items.map((item) => {
                const dest = item.done ? null : destinationFor(item.key);
                return (
                  <div className="row between" key={item.key} style={{ alignItems: "flex-start", padding: "14px 16px", borderTop: "1px solid var(--ink-800, rgba(255,255,255,0.04))" }}>
                    <div className="row gap-8" style={{ alignItems: "flex-start" }}>
                      <span
                        aria-hidden
                        style={{
                          flex: "0 0 auto",
                          width: 24,
                          height: 24,
                          borderRadius: "50%",
                          display: "grid",
                          placeItems: "center",
                          fontSize: 13,
                          marginTop: 1,
                          color: item.done ? "var(--pos)" : "var(--text-faint)",
                          border: `1px solid ${item.done ? "rgba(95, 211, 139, 0.4)" : "rgba(255,255,255,0.12)"}`,
                          background: item.done ? "rgba(95, 211, 139, 0.1)" : "transparent",
                        }}
                      >
                        {item.done ? "✓" : "○"}
                      </span>
                      <div>
                        <div style={{ fontWeight: 600, color: item.done ? "var(--text-faint)" : undefined, textDecoration: item.done ? "line-through" : undefined }}>
                          {item.label}
                        </div>
                        <div className="muted" style={{ fontSize: 12.5, marginTop: 3, maxWidth: 540 }}>
                          {item.hint}
                        </div>
                      </div>
                    </div>
                    {item.done ? (
                      <span className="faint mono" style={{ fontSize: 11, whiteSpace: "nowrap", marginTop: 2 }}>done</span>
                    ) : dest ? (
                      <button className="btn sm primary" style={{ flex: "0 0 auto", whiteSpace: "nowrap" }} onClick={() => navigate(dest.to)}>
                        {dest.cta}
                      </button>
                    ) : (
                      <span className="faint mono" style={{ fontSize: 11, whiteSpace: "nowrap", marginTop: 2 }}>pending</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {allDone && (
        <div className="mt-24">
          <Card title="You're live" sub="tracking, offer, and affiliates are all in place">
            <div className="row between mt-16">
              <span className="muted" style={{ fontSize: 13 }}>Every launch step is complete. The recruitment engine can now run at full tilt.</span>
              <button className="btn primary" onClick={() => navigate("/recruitment")}>
                ⌖ Start recruiting
              </button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
