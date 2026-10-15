import { useState } from "react";
import { api, errorMessage, errorStatus, getMerchant, shortDate } from "../api";
import { useAuth, roleAtLeast } from "../auth";
import { useApi, Card, Spinner, ErrorBanner, Notice, PageHeader, Badge, EmptyState, Field, Modal, statusKind } from "../ui";

/**
 * `GET /merchants/:id` — the PUBLIC merchant. The API strips `postbackSecret` from every
 * general read (`sanitize.ts`); it is only available from the admin-gated
 * `GET /merchants/:id/postback-secret` and in the response to a rotation. Declaring it
 * here is what crashed this screen, so it is deliberately absent. Fields the API can omit
 * (older rows, optional columns) are optional and read through a fallback.
 */
interface Merchant {
  id: string;
  name: string;
  niche?: string | null;
  competitors?: string[] | null;
  physicalAddress?: string | null;
  bookingUrl?: string | null;
  defaultCurrency?: string | null;
}

type Role = "owner" | "admin" | "manager" | "analyst" | "viewer";

/** A membership row (`MerchantUser` entity). `id` is the MEMBERSHIP id; the member routes
 *  are keyed by `userId`. */
interface MerchantUser {
  id: string;
  userId: string;
  email: string;
  name?: string | null;
  role: Role;
  status: "active" | "invited" | "disabled" | (string & {});
}

interface AuditLog {
  id: string;
  action: string;
  subjectType: string;
  subjectId?: string | null;
  /** The acting user's id. Most routes do not record one yet, so it is usually null. */
  actorId?: string | null;
  ts: string;
}

const SECRET_MASK = "•".repeat(28);

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

/** "cal.com/you" → "https://cal.com/you" — the API validates the booking link as a full URL. */
function withScheme(url: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

function GeneralTab({ mid }: { mid: string }) {
  const { activeRole } = useAuth();
  const { data, loading, error, reload } = useApi<Merchant>(() => api.get(`/merchants/${mid}`), [mid]);
  const [form, setForm] = useState<{ name: string; niche: string; competitors: string; physicalAddress: string; bookingUrl: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;
  if (!data) return null;

  const competitors = data.competitors ?? [];
  // An unknown role (should not happen) is left for the server to judge.
  const canEdit = activeRole == null || roleAtLeast(activeRole, "admin");

  const f =
    form ?? {
      name: data.name ?? "",
      niche: data.niche ?? "",
      competitors: competitors.join(", "),
      physicalAddress: data.physicalAddress ?? "",
      bookingUrl: data.bookingUrl ?? "",
    };

  async function save() {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const bookingUrl = f.bookingUrl.trim();
      await api.patch(`/merchants/${mid}`, {
        name: f.name.trim(),
        niche: f.niche.trim() || null,
        competitors: f.competitors.split(",").map((c) => c.trim()).filter(Boolean),
        physicalAddress: f.physicalAddress.trim() || null,
        bookingUrl: bookingUrl ? withScheme(bookingUrl) : null,
      });
      setMsg("Workspace updated.");
      setForm(null);
      reload();
    } catch (e) {
      setErr(errorStatus(e) === 403 ? "Only workspace admins and owners can change these settings." : errorMessage(e, "save failed"));
    } finally {
      setSaving(false);
    }
  }

  const dirty = form !== null;

  return (
    <div className="grid grid-2">
      <Card title="Workspace identity" sub="niche + competitors feed the recruitment sourcing engine">
        {err && <ErrorBanner message={err} />}
        {msg && <Notice kind="ok">{msg}</Notice>}
        {!canEdit && (
          <Notice kind="info">
            Your role ({activeRole}) can view these settings. Only admins and owners can change them.
          </Notice>
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

          <Field label="Booking link (for A-tier meetings)">
            <input
              className="input"
              value={f.bookingUrl}
              onChange={(e) => setForm({ ...f, bookingUrl: e.target.value })}
              placeholder="https://cal.com/you/intro"
            />
          </Field>
          <div className="faint" style={{ fontSize: 11, marginTop: -6, marginBottom: 12 }}>
            Your Calendly/Cal.com/SavvyCal link — the AI-SDR hands this to warm A-tier replies to book a call.
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
        <PostbackSecretCard mid={mid} />

        <div className="grid grid-2 mt-24">
          <Card title="Default currency">
            <div className="mono" style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>
              {data.defaultCurrency ?? "—"}
            </div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
              Commissions and payouts are denominated here.
            </div>
          </Card>
          <Card title="Competitor set">
            <div className="row gap-8" style={{ flexWrap: "wrap", marginTop: 8 }}>
              {competitors.length ? (
                competitors.map((c) => (
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

/**
 * The postback secret is never part of the merchant payload. It is fetched on demand from
 * the admin-gated route when someone presses Reveal, held only while it is on screen, and
 * dropped again on Hide. Rotation (owner-only) answers with the new secret directly.
 */
function PostbackSecretCard({ mid }: { mid: string }) {
  const { activeRole } = useAuth();
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<"reveal" | "rotate" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Up-front explanation only — the server decides, and its 403 is handled below either way.
  const mayReveal = activeRole == null || roleAtLeast(activeRole, "admin");
  const mayRotate = activeRole == null || roleAtLeast(activeRole, "owner");

  async function reveal() {
    setBusy("reveal");
    setErr(null);
    setNote(null);
    try {
      const res = await api.get<{ postbackSecret?: unknown } | null>(`/merchants/${mid}/postback-secret`);
      const value = res?.postbackSecret;
      if (typeof value !== "string" || !value) throw new Error("The server did not return a secret.");
      setSecret(value);
    } catch (e) {
      setErr(
        errorStatus(e) === 403
          ? "Only workspace admins and owners can reveal the postback secret. Ask one of them to share it with you securely."
          : errorMessage(e, "Could not load the secret."),
      );
    } finally {
      setBusy(null);
    }
  }

  function hide() {
    setSecret(null);
    setCopied(false);
  }

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setErr("Could not copy automatically — select the secret and copy it by hand.");
    }
  }

  async function rotate() {
    if (!confirm("Rotate the postback secret? Existing integrations using the old secret will stop validating.")) return;
    setBusy("rotate");
    setErr(null);
    setNote(null);
    try {
      const res = await api.post<{ postbackSecret?: unknown } | null>(`/merchants/${mid}/rotate-postback-secret`, {});
      const value = res?.postbackSecret;
      if (typeof value === "string" && value) {
        setSecret(value);
        setCopied(false);
        setNote("Secret rotated — the new value is shown below. Update your integrations now; the old secret no longer validates.");
      } else {
        setSecret(null);
        setNote("Secret rotated. Press Reveal to see the new value, then update your integrations.");
      }
    } catch (e) {
      setErr(errorStatus(e) === 403 ? "Only the workspace owner can rotate the postback secret." : errorMessage(e, "Rotation failed."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Postback secret" sub="signs server-to-server conversion postbacks">
      <div className="mt-16">
        {err && <ErrorBanner message={err} />}
        {note && <Notice kind="ok">{note}</Notice>}
        <div
          className="card"
          style={{ background: "var(--ink-850)", padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
        >
          <span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }} aria-label={secret ? "postback secret" : "postback secret (hidden)"}>
            {secret ?? SECRET_MASK}
          </span>
          <div className="row gap-8" style={{ flex: "0 0 auto" }}>
            {secret && (
              <button className="btn sm ghost" onClick={copy}>
                {copied ? "✓ copied" : "Copy"}
              </button>
            )}
            {secret ? (
              <button className="btn sm ghost" onClick={hide}>
                Hide
              </button>
            ) : (
              <button
                className="btn sm ghost"
                onClick={reveal}
                disabled={busy !== null || !mayReveal}
                title={mayReveal ? undefined : "Admins and owners only"}
              >
                {busy === "reveal" ? "loading…" : "Reveal"}
              </button>
            )}
          </div>
        </div>
        <div className="faint" style={{ fontSize: 11.5, margin: "12px 0" }}>
          Treat this like a password. Rotating it invalidates the previous secret immediately.
          {!mayReveal && <> Your role ({activeRole}) cannot reveal it — admins and owners can.</>}
          {mayReveal && !mayRotate && <> Only the workspace owner can rotate it.</>}
        </div>
        <button className="btn danger sm" onClick={rotate} disabled={busy !== null || !mayRotate} title={mayRotate ? undefined : "Owner only"}>
          {busy === "rotate" ? "rotating…" : "Rotate secret"}
        </button>
      </div>
    </Card>
  );
}

// ---- Team -------------------------------------------------------------------

function TeamTab({ mid }: { mid: string }) {
  const { data, loading, error, reload } = useApi<MerchantUser[]>(() => api.get(`/merchants/${mid}/users`), [mid]);
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState<{ email: string; name: string; role: Role }>({ email: "", name: "", role: "viewer" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Errors here show the API's own text: its 403s are specific ("cannot grant the higher
  // role…", "cannot modify a higher-ranked member") and say more than a generic message.
  async function addMember() {
    const email = invite.email.trim();
    setSaving(true);
    setInviteErr(null);
    setNote(null);
    try {
      const member = await api.post<MerchantUser | null>(`/merchants/${mid}/users`, {
        email,
        // The API requires a name; fall back to the mailbox name rather than failing the add.
        name: invite.name.trim() || email.split("@")[0] || email,
        role: invite.role,
      });
      setOpen(false);
      setInvite({ email: "", name: "", role: "viewer" });
      setNote(
        member?.status === "invited"
          ? // Honest about the gap: the API creates the seat but mails nothing, and this app
            // has no accept-invite screen for the password-less account to finish signup.
            `${email} was added as "invited". Invitation emails and the accept-invite screen aren't available yet, so they can't sign in until then.`
          : `${email} now has ${invite.role} access.`,
      );
      reload();
    } catch (e) {
      setInviteErr(errorMessage(e, "Could not add the member."));
    } finally {
      setSaving(false);
    }
  }

  async function updateUser(u: MerchantUser, patch: { role?: Role; status?: "active" | "disabled" }) {
    setErr(null);
    setNote(null);
    try {
      // Keyed by the USER id — the membership id (`u.id`) is not what the route looks up.
      await api.patch(`/merchants/${mid}/users/${encodeURIComponent(u.userId)}`, patch);
      reload();
    } catch (e) {
      setErr(errorMessage(e, "Update failed."));
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
          <button className="btn primary sm" onClick={() => { setInviteErr(null); setOpen(true); }}>
            + Add member
          </button>
        }
      >
        {(err || note) && (
          <div style={{ padding: "0 20px" }}>
            {err && <ErrorBanner message={err} />}
            {note && <Notice kind="ok">{note}</Notice>}
          </div>
        )}
        {users.length === 0 ? (
          <div style={{ padding: 20 }}>
            <EmptyState
              title="No team members yet"
              hint="Add teammates and assign roles to delegate recruitment, payouts, and reporting."
              action={
                <button className="btn primary" onClick={() => setOpen(true)}>
                  Add member
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
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{u.name || "—"}</div>
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
                    <td className="num">
                      {u.status === "disabled" ? (
                        <button className="btn sm" onClick={() => updateUser(u, { status: "active" })}>
                          Reactivate
                        </button>
                      ) : (
                        <button className="btn sm ghost" onClick={() => updateUser(u, { status: "disabled" })}>
                          {u.status === "invited" ? "Revoke" : "Suspend"}
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

      <Modal open={open} onClose={() => setOpen(false)} title="Add team member">
        {inviteErr && <ErrorBanner message={inviteErr} />}
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
          <div className="faint" style={{ fontSize: 11.5 }}>
            Someone who already has a Vantage login gets access straight away. A new address is added as "invited" —
            invitation emails aren't available yet, so they can't sign in until then.
          </div>
          <div className="row gap-8 mt-16">
            <button className="btn primary" onClick={addMember} disabled={saving || !invite.email.trim()}>
              {saving ? "adding…" : "Add member"}
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
  const { data, loading, error, errorStatus: status } = useApi<{ items?: AuditLog[] } | null>(() => api.get("/admin/audit-logs?limit=50"), []);

  if (loading) return <Spinner />;
  if (error) {
    return status === 403 ? (
      <EmptyState title="The audit log is for admins and owners" hint="Your role can't view governance events. Ask a workspace admin if you need something checked." />
    ) : (
      <ErrorBanner message={error} />
    );
  }
  const items = data?.items ?? [];

  return (
    <Card flush title="Audit log" sub="last 50 governance events — what changed, and when">
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
                  <td className="muted mono" style={{ fontSize: 12 }}>
                    {l.actorId ? l.actorId : <span className="faint">not recorded</span>}
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
