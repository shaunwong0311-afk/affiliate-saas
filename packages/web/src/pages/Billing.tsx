import { useState } from "react";
import { api, money, num, shortDate } from "../api";
import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, statusKind } from "../ui";

type PlanKey = "track_export" | "managed_payouts" | "done_for_you";

interface Subscription {
  plan: PlanKey;
  status: string;
  trialEndsAt: string | null;
  renewsAt: string | null;
}

interface Entitlement {
  feature: string;
  limitValue: number;
}

type UsageMap = Record<string, number>;
type UsageRow = { kind: string; total: number };

const PLANS: { key: PlanKey; name: string; tier: string; tagline: string; bullets: string[]; priceCents: number }[] = [
  {
    key: "track_export",
    name: "Track & Export",
    tier: "A",
    tagline: "You run the program",
    bullets: [
      "Attribution, links, and clean conversion tracking",
      "Self-serve CSV/Sheets export to your own payout rails",
      "Recruitment sourcing, scoring, and outreach included",
    ],
    priceCents: 9900,
  },
  {
    key: "managed_payouts",
    name: "Managed Payouts",
    tier: "B",
    tagline: "We move the money",
    bullets: [
      "Everything in Track & Export",
      "Held balances, clawbacks, and reversal handling",
      "Automated multi-rail payouts with compliance + tax",
    ],
    priceCents: 29900,
  },
  {
    key: "done_for_you",
    name: "Done-For-You",
    tier: "C",
    tagline: "We run recruitment",
    bullets: [
      "Everything in Managed Payouts",
      "Managed sourcing, outreach sequences, and activation",
      "A dedicated operator owning your producing-affiliate count",
    ],
    priceCents: 99900,
  },
];

function planMeta(key: PlanKey) {
  return PLANS.find((p) => p.key === key) ?? PLANS[0];
}

function normalizeUsage(raw: UsageMap | UsageRow[] | null): UsageRow[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw).map(([kind, total]) => ({ kind, total: Number(total) || 0 }));
}

export function Billing() {
  const sub = useApi<Subscription>(() => api.get("/billing/subscription"));
  const ents = useApi<Entitlement[]>(() => api.get("/billing/entitlements"));
  const usage = useApi<UsageMap | UsageRow[]>(() => api.get("/billing/usage"));

  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function choosePlan(plan: PlanKey) {
    if (sub.data?.plan === plan) return;
    setBusy(plan);
    setMsg(null);
    setErr(null);
    try {
      await api.post("/billing/subscription/plan", { plan });
      setMsg(`Plan changed to ${planMeta(plan).name}.`);
      sub.reload();
      ents.reload();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to change plan");
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    setMsg(null);
    setErr(null);
    try {
      await api.post("/billing/cancel", {});
      setMsg("Subscription set to cancel at period end.");
      sub.reload();
    } catch (e: any) {
      setErr(e?.message ?? "Cancel failed");
    } finally {
      setBusy(null);
    }
  }

  async function reactivate() {
    setBusy("reactivate");
    setMsg(null);
    setErr(null);
    try {
      await api.post("/billing/reactivate", {});
      setMsg("Subscription reactivated.");
      sub.reload();
    } catch (e: any) {
      setErr(e?.message ?? "Reactivate failed");
    } finally {
      setBusy(null);
    }
  }

  async function adjustEntitlement(feature: string, limitValue: number) {
    setBusy(`ent:${feature}`);
    setMsg(null);
    setErr(null);
    try {
      await api.put("/billing/entitlements", { feature, limitValue });
      ents.reload();
    } catch (e: any) {
      setErr(e?.message ?? "Failed to update entitlement");
    } finally {
      setBusy(null);
    }
  }

  if (sub.loading) return <Spinner />;
  if (sub.error) return <ErrorBanner message={sub.error} />;
  if (!sub.data) return null;

  const current = sub.data;
  const meta = planMeta(current.plan);
  const usageRows = normalizeUsage(usage.data);
  const entitlements = ents.data ?? [];
  const canceling = current.status === "canceled" || current.status === "cancelling" || current.status === "cancelled";
  const usageByKind = new Map(usageRows.map((r) => [r.kind, r.total]));

  return (
    <>
      <PageHeader
        title="Billing & entitlements"
        crumb="OPERATIONAL TIER"
        subtitle="Your plan is your operational-involvement tier. The further you climb, the more of recruitment, money movement, and activation we own on your behalf."
        actions={
          canceling ? (
            <button className="btn primary" onClick={reactivate} disabled={busy === "reactivate"}>
              {busy === "reactivate" ? "reactivating…" : "Reactivate"}
            </button>
          ) : (
            <button className="btn ghost" onClick={cancel} disabled={busy === "cancel"}>
              {busy === "cancel" ? "canceling…" : "Cancel plan"}
            </button>
          )
        }
      />

      {msg && (
        <div className="err-banner" style={{ background: "var(--acc-glow)", borderColor: "var(--acc-dim)", color: "var(--acc)", marginBottom: 18 }}>
          {msg}
        </div>
      )}
      {err && <div style={{ marginBottom: 18 }}><ErrorBanner message={err} /></div>}

      <div className="grid grid-4">
        <Stat
          label="Current plan"
          value={meta.name}
          foot={<Badge kind={statusKind(current.status)}>{current.status}</Badge>}
        />
        <Stat label="Tier price" value={money(meta.priceCents)} foot="per month" footClass="muted" />
        <Stat label="Renews" value={shortDate(current.renewsAt)} foot={canceling ? "ends at period close" : "auto-renews"} footClass={canceling ? "neg" : "muted"} />
        <Stat label="Trial ends" value={shortDate(current.trialEndsAt)} foot={current.trialEndsAt ? "trialing" : "no trial"} footClass="muted" />
      </div>

      <div className="mt-24">
        <Card title="Choose your involvement tier" sub="track & export → managed payouts → done-for-you recruitment">
          <div className="grid grid-3 mt-16">
            {PLANS.map((p) => {
              const active = p.key === current.plan;
              return (
                <div
                  key={p.key}
                  className="card"
                  onClick={() => choosePlan(p.key)}
                  style={{
                    cursor: active ? "default" : "pointer",
                    background: active ? "var(--acc-glow)" : "var(--ink-850)",
                    borderColor: active ? "var(--acc-dim)" : "var(--line)",
                    opacity: busy && busy !== p.key && busy.indexOf("ent:") !== 0 ? 0.6 : 1,
                    transition: "border-color .15s, background .15s",
                  }}
                >
                  <div className="row between">
                    <Badge kind={`tier-${p.tier}`}>Tier {p.tier}</Badge>
                    {active ? <Badge kind="pos">current</Badge> : busy === p.key ? <span className="faint" style={{ fontSize: 11 }}>switching…</span> : null}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 12 }}>{p.name}</div>
                  <div className="faint mono" style={{ fontSize: 11.5, marginTop: 2, textTransform: "uppercase", letterSpacing: "0.08em" }}>{p.tagline}</div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 600, marginTop: 14, letterSpacing: "-0.02em" }}>
                    {money(p.priceCents)}<span className="faint" style={{ fontSize: 12, fontWeight: 400 }}> /mo</span>
                  </div>
                  <div style={{ marginTop: 14 }}>
                    {p.bullets.map((b, i) => (
                      <div key={i} className="muted" style={{ fontSize: 12.5, marginBottom: 7, display: "flex", gap: 8 }}>
                        <span className="acc">▸</span>
                        <span>{b}</span>
                      </div>
                    ))}
                  </div>
                  {!active && (
                    <button
                      className="btn primary sm"
                      style={{ marginTop: 14, width: "100%" }}
                      onClick={(e) => { e.stopPropagation(); choosePlan(p.key); }}
                      disabled={busy === p.key}
                    >
                      {busy === p.key ? "switching…" : `Switch to ${p.name}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <div className="grid grid-2 mt-24">
        <Card flush title="Usage this period" sub="metered consumption by kind">
          {usage.loading ? (
            <div style={{ padding: 20 }}><Spinner /></div>
          ) : usage.error ? (
            <div style={{ padding: 20 }}><ErrorBanner message={usage.error} /></div>
          ) : usageRows.length === 0 ? (
            <EmptyState title="No usage recorded" hint="Metered events — sourcing runs, outreach sends, tracked conversions, and payouts — will appear here as they accrue." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {usageRows.map((r) => (
                  <tr key={r.kind}>
                    <td style={{ fontWeight: 600 }}>{r.kind.replace(/_/g, " ")}</td>
                    <td className="num mono">{num(r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card flush title="Entitlements" sub="feature limits unlocked by your tier">
          {ents.loading ? (
            <div style={{ padding: 20 }}><Spinner /></div>
          ) : ents.error ? (
            <div style={{ padding: 20 }}><ErrorBanner message={ents.error} /></div>
          ) : entitlements.length === 0 ? (
            <EmptyState title="No entitlements" hint="Entitlements are provisioned from your plan. Change your tier to unlock more capacity." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th className="num">Limit</th>
                  <th className="num">Used</th>
                  <th className="num">Adjust</th>
                </tr>
              </thead>
              <tbody>
                {entitlements.map((e) => {
                  const used = usageByKind.get(e.feature);
                  const overLimit = used != null && e.limitValue >= 0 && used > e.limitValue;
                  return (
                    <tr key={e.feature}>
                      <td style={{ fontWeight: 600 }}>{e.feature.replace(/_/g, " ")}</td>
                      <td className="num mono">{e.limitValue < 0 ? "∞" : num(e.limitValue)}</td>
                      <td className={`num mono ${overLimit ? "neg" : "muted"}`}>{used != null ? num(used) : "—"}</td>
                      <td className="num">
                        <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
                          <button
                            className="btn ghost sm"
                            disabled={busy === `ent:${e.feature}` || e.limitValue <= 0}
                            onClick={() => adjustEntitlement(e.feature, Math.max(0, e.limitValue - 1))}
                          >
                            −
                          </button>
                          <button
                            className="btn ghost sm"
                            disabled={busy === `ent:${e.feature}`}
                            onClick={() => adjustEntitlement(e.feature, e.limitValue + 1)}
                          >
                            +
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="mt-24">
        <Card title="What your tier owns" sub="the thesis: tracking is the floor, operational involvement is the ladder">
          <div className="grid grid-3 mt-16">
            {PLANS.map((p) => (
              <div key={p.key} className="muted" style={{ fontSize: 13 }}>
                <strong className="acc">{p.name}</strong>
                <p style={{ marginTop: 4 }}>{p.tagline}. {p.bullets[p.bullets.length - 1]}.</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
