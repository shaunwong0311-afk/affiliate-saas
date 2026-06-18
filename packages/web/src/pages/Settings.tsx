import { useState } from "react";
import { api, getMerchant, shortDate } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, Field, Modal, statusKind } from "../ui";

interface Merchant {
  id: string;
  name: string;
  niche: string | null;
  competitors: string[];
  physicalAddress: string | null;
  defaultCurrency: string;
  postbackSecret: string;
}

type Role = "owner" | "admin" | "manager" | "analyst" | "viewer";

interface MerchantUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: string;
  lastActiveAt: string | null;
}

interface AuditLog {
  id: string;
  action: string;
  subjectType: string;
  subjectId: string | null;
  actorEmail: string | null;
  ts: string;
}

const ROLES: Role[] = ["owner", "admin", "manager", "analyst", "viewer"];
const TABS = ["General", "Team", "Audit log"] as const;
type Tab = (typeof TABS)[number];

export function Settings() {
  const mid = getMerchant();
  const [tab, setTab] = useState<Tab>("General");

  if (!mid) return <ErrorBanner message="No active merchant selected." />;

  return (
    <>
      <PageHeader
        title="Settings"
        crumb="WORKSPACE"
        subtitle="Identity, targeting, and governance. Your niche and competitor set drive recruitment; your team's roles and the audit trail keep the workspace accountable."
      />

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </div>
        ))}
      </div>

      {tab === "General" && <GeneralTab mid={mid} />}
      {tab === "Team" && <TeamTab mid={mid} />}
      {tab === "Audit log" && <AuditTab />}
    </>
  );
}

// ---- General ----------------------------------------------------------------

function GeneralTab({ mid }: { mid: string }) {
  const { data, loading, error, reload } = useApi<Merchant>(() => api.get(`/merchants/${mid}`), [mid]);
  const [form, setForm] = useState<{ name: string; niche: string; competitors: string; physicalAddress: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return null;

  const f =
    form ?? {
      name: data.name,
      niche: data.niche ?? "",
      competitors: data.competitors.join(", "),
      physicalAddress: data.physicalAddress ?? "",
    };

  async function save() {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      await api.patch(`/merchants/${mid}`, {
        name: f.name.trim(),
        niche: f.niche.trim() || null,
        competitors: f.competitors.split(",").map((c) => c.trim()).filter(Boolean),
        physicalAddress: f.physicalAddress.trim() || null,
      });
      setMsg("Workspace updated.");
      setForm(null);
      reload();
    } catch (e: any) {
      setErr(e?.message ?? "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    if (!confirm("Rotate the postback secret? Existing integrations using the old secret will stop validating.")) return;
    setRotating(true);
    setErr(null);
    setMsg(null);
    try {
      await api.post<{ postbackSecret: string }>(`/merchants/${mid}/rotate-postback-secret`, {});
      setMsg("Postback secret rotated — update your integrations.");
      setRevealed(true);
      reload();
    } catch (e: any) {
      setErr(e?.message ?? "rotate failed");
    } finally {
      setRotating(false);
    }
  }

  const dirty = form !== null;

  return (
    <div className="grid grid-2">
      <Card title="Workspace identity" sub="niche + competitors feed the recruitment sourcing engine">
        {err && <ErrorBanner message={err} />}
        {msg && (
          <div className="err-banner" style={{ background: "var(--acc-glow)", borderColor: "var(--acc-dim)", color: "var(--acc)" }}>
            {msg}
          </div>
        )}

        <div className="mt-16">
          <Field label="Merchant name">
            <input className="input" value={f.name} onChange={(e) => setForm({ ...f, name: e.target.value })} placeholder="Acme Co." />
          </Field>
          <Field label="Niche">
            <input className="input" value={f.niche} onChange={(e) => setForm({ ...f, niche: e.target.value })} placeholder="e.g. home fitness equipment" />
          </Field>
          <Field label="Competitors (comma-separated)">
            <input
              className="input"
              value={f.competitors}
              onChange={(e) => setForm({ ...f, competitors: e.target.value })}
              placeholder="competitor-a.com, competitor-b.com"
            />
          </Field>
          <Field label="Physical address (CAN-SPAM)">
            <textarea
              className="input"
              rows={2}
              value={f.physicalAddress}
              onChange={(e) => setForm({ ...f, physicalAddress: e.target.value })}
              placeholder="123 Market St, Suite 400, San Francisco, CA 94103"
            />
          </Field>
          <div className="faint" style={{ fontSize: 11, marginTop: -6, marginBottom: 12 }}>
            Required in the footer of every outreach email to stay compliant.
          </div>

          <div className="row gap-8">
            <button className="btn primary" onClick={save} disabled={saving || !dirty || !f.name.trim()}>
              {saving ? "saving…" : "Save changes"}
            </button>
            {dirty && (
              <button className="btn ghost" onClick={() => setForm(null)} disabled={saving}>
                Discard
              </button>
            )}
          </div>
        </div>
      </Card>

      <div>
        <Card title="Postback secret" sub="signs server-to-server conversion postbacks">
          <div className="mt-16">
            <div
              className="card"
              style={{ background: "var(--ink-850)", padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
            >
              <span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
                {revealed ? data.postbackSecret : data.postbackSecret.replace(/./g, "•").slice(0, 28)}
              </span>
              <button className="btn sm ghost" onClick={() => setRevealed((v) => !v)}>
                {revealed ? "Hide" : "Reveal"}
              </button>
            </div>
            <div className="faint" style={{ fontSize: 11.5, margin: "12px 0" }}>
              Treat this like a password. Rotating it invalidates the previous secret immediately.
            </div>
            <button className="btn danger sm" onClick={rotate} disabled={rotating}>
              {rotating ? "rotating…" : "Rotate secret"}
            </button>
          </div>
        </Card>

        <div className="grid grid-2 mt-24">
          <Card title="Default currency">
            <div className="mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>
              {data.defaultCurrency}
            </div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
              Commissions and payouts are denominated here.
            </div>
          </Card>
          <Card title="Competitor set">
            <div className="row gap-8" style={{ flexWrap: "wrap", marginTop: 8 }}>
              {data.competitors.length ? (
                data.competitors.map((c) => (
                  <Badge key={c} kind="info">
                    {c}
                  </Badge>
                ))
              ) : (
                <Badge kind="warn">none set</Badge>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---- Team -------------------------------------------------------------------

function TeamTab({ mid }: { mid: string }) {
  const { data, loading, error, reload } = useApi<MerchantUser[]>(() => api.get(`/merchants/${mid}/users`), [mid]);
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState<{ email: string; name: string; role: Role }>({ email: "", name: "", role: "viewer" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function sendInvite() {
    setSaving(true);
    setErr(null);
    try {
      await api.post(`/merchants/${mid}/users`, {
        email: invite.email.trim(),
        name: invite.name.trim() || null,
        role: invite.role,
      });
      setOpen(false);
      setInvite({ email: "", name: "", role: "viewer" });
      reload();
    } catch (e: any) {
      setErr(e?.message ?? "invite failed");
    } finally {
      setSaving(false);
    }
  }

  async function updateUser(u: MerchantUser, patch: { role?: Role; status?: string }) {
    try {
      await api.patch(`/merchants/${mid}/users/${u.id}`, patch);
      reload();
    } catch (e: any) {
      setErr(e?.message ?? "update failed");
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;
  const users = data ?? [];

  return (
    <>
      <Card
        flush
        title={`Team · ${users.length}`}
        sub="roles gate access — owners and admins govern, analysts and viewers observe"
        actions={
          <button className="btn primary sm" onClick={() => setOpen(true)}>
            + Invite member
          </button>
        }
      >
        {err && <ErrorBanner message={err} />}
        {users.length === 0 ? (
          <div style={{ padding: 20 }}>
            <EmptyState
              title="No team members yet"
              hint="Invite teammates and assign roles to delegate recruitment, payouts, and reporting."
              action={
                <button className="btn primary" onClick={() => setOpen(true)}>
                  Invite member
                </button>
              }
            />
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th className="num">Last active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{u.name ?? "—"}</div>
                      <div className="faint mono" style={{ fontSize: 11 }}>
                        {u.email}
                      </div>
                    </td>
                    <td>
                      <select
                        className="select"
                        value={u.role}
                        onChange={(e) => updateUser(u, { role: e.target.value as Role })}
                        style={{ minWidth: 120 }}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <Badge kind={statusKind(u.status)}>{u.status}</Badge>
                    </td>
                    <td className="num muted" style={{ fontSize: 12 }}>
                      {shortDate(u.lastActiveAt)}
                    </td>
                    <td className="num">
                      {u.status === "active" ? (
                        <button className="btn sm ghost" onClick={() => updateUser(u, { status: "paused" })}>
                          Suspend
                        </button>
                      ) : (
                        <button className="btn sm" onClick={() => updateUser(u, { status: "active" })}>
                          Reactivate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Invite team member">
        {err && <ErrorBanner message={err} />}
        <div style={{ padding: "4px 0" }}>
          <Field label="Email">
            <input
              className="input"
              type="email"
              value={invite.email}
              onChange={(e) => setInvite({ ...invite, email: e.target.value })}
              placeholder="teammate@company.com"
            />
          </Field>
          <Field label="Name">
            <input
              className="input"
              value={invite.name}
              onChange={(e) => setInvite({ ...invite, name: e.target.value })}
              placeholder="Jordan Lee"
            />
          </Field>
          <Field label="Role">
            <select className="select" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value as Role })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <div className="row gap-8 mt-16">
            <button className="btn primary" onClick={sendInvite} disabled={saving || !invite.email.trim()}>
              {saving ? "sending…" : "Send invite"}
            </button>
            <button className="btn ghost" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ---- Audit log --------------------------------------------------------------

function AuditTab() {
  const { data, loading, error } = useApi<{ items: AuditLog[] }>(() => api.get("/admin/audit-logs?limit=50"), []);

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;
  const items = data?.items ?? [];

  return (
    <Card flush title="Audit log" sub="last 50 governance events — who changed what, and when">
      {items.length === 0 ? (
        <div style={{ padding: 20 }}>
          <EmptyState title="No audit events yet" hint="Member changes, secret rotations, and payout approvals will appear here." />
        </div>
      ) : (
        <div style={{ marginTop: 14, maxHeight: 620, overflow: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Subject</th>
                <th>Actor</th>
                <th className="num">When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <tr key={l.id}>
                  <td>
                    <span className="mono" style={{ fontSize: 12.5 }}>
                      {l.action}
                    </span>
                  </td>
                  <td>
                    <Badge>{l.subjectType}</Badge>
                    {l.subjectId && (
                      <span className="faint mono" style={{ fontSize: 11, marginLeft: 8 }}>
                        {l.subjectId.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {l.actorEmail ?? "system"}
                  </td>
                  <td className="num muted" style={{ fontSize: 12 }}>
                    {shortDate(l.ts)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
