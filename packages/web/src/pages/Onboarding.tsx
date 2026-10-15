import { api, num } from "../api";
import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, EmptyState } from "../ui";
import { navigate } from "../router";

interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  hint: string;
}

interface Checklist {
  items?: ChecklistItem[];
  completed?: number;
  total?: number;
  /** Sent by the API as a whole number 0–100. Not used: progress is derived from the items. */
  percentComplete?: number;
}

/**
 * Where each incomplete step gets resolved — keyed by the exact keys the checklist route
 * emits (`routes/onboarding.ts`). A step whose screen does not exist yet (agreements,
 * creatives) has no entry and shows as "pending" rather than linking somewhere unrelated.
 */
const DESTINATIONS: Record<string, { to: string; cta: string }> = {
  storeConnected: { to: "/integrations", cta: "Connect a store →" },
  payoutConfigured: { to: "/payouts", cta: "Open payouts →" },
  mailboxConnected: { to: "/integrations", cta: "Connect a mailbox →" },
  programCreated: { to: "/programs", cta: "Set up program →" },
  offerCreated: { to: "/programs", cta: "Add an offer →" },
  testConversionRun: { to: "/settings", cta: "Postback secret →" },
  firstAffiliate: { to: "/affiliates", cta: "Add affiliates →" },
  campaignReady: { to: "/campaigns", cta: "Draft a campaign →" },
};

function destinationFor(key: string): { to: string; cta: string } | null {
  return Object.prototype.hasOwnProperty.call(DESTINATIONS, key) ? DESTINATIONS[key]! : null;
}

export function Onboarding() {
  const { data, loading, error, reload } = useApi<Checklist | null>(() => api.get("/onboarding/checklist"));

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return null;

  const items = data.items ?? [];
  const total = data.total ?? items.length;
  const completed = data.completed ?? items.filter((i) => i.done).length;
  // A 0..1 fraction computed here. The API's `percentComplete` is already ×100, and
  // feeding that to a formatter that multiplies by 100 showed "3000.0%" and a bar thirty
  // screens wide.
  const fraction = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
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
          value={`${Math.round(fraction * 100)}%`}
          foot={`${num(completed)} of ${num(total)} complete`}
          footClass={allDone ? "pos" : "muted"}
        />
        <Stat label="Steps remaining" value={num(Math.max(0, total - completed))} small foot="until you're fully live" footClass="muted" />
        <Stat label="Steps done" value={num(completed)} small foot={`${num(total)} total`} footClass="muted" />
      </div>

      <div className="funnel-step" style={{ marginTop: 20, marginBottom: 4 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>completion</span>
        <div className="funnel-bar" style={{ width: `${Math.max(6, Math.round(fraction * 100))}%` }}>
          {Math.round(fraction * 100)}%
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
