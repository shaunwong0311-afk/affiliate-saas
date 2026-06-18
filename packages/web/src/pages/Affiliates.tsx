import { useMemo, useState } from "react";
import { api, num, shortDate } from "../api";
import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, Field, Modal, statusKind } from "../ui";
import { navigate } from "../router";

interface AffiliateObj {
  name?: string | null;
  primaryEmail?: string | null;
  country?: string | null;
}

interface Relationship {
  id: string;
  affiliateId: string;
  status: string;
  role: string;
  tags?: string[] | null;
  joinedAt: string | null;
  source: string | null;
  affiliate?: AffiliateObj | null;
  // defensive flattened fallbacks
  name?: string | null;
  primaryEmail?: string | null;
  email?: string | null;
  country?: string | null;
}

interface Program {
  id: string;
  name: string;
}

const STATUS_FILTERS = ["all", "active", "pending", "paused", "rejected"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function affName(r: Relationship): string {
  return r.affiliate?.name ?? r.name ?? "Unnamed affiliate";
}
function affEmail(r: Relationship): string {
  return r.affiliate?.primaryEmail ?? r.primaryEmail ?? r.email ?? "no email";
}
function affCountry(r: Relationship): string | null {
  return r.affiliate?.country ?? r.country ?? null;
}

export function Affiliates() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [role, setRole] = useState<string>("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: "100" });
    if (status !== "all") p.set("status", status);
    if (role) p.set("role", role);
    return p.toString();
  }, [status, role]);

  const { data, loading, error, reload } = useApi<{ items: Relationship[]; total: number }>(
    () => api.get(`/affiliates?${qs}`),
    [qs]
  );
  const programs = useApi<{ items: Program[]; total: number } | Program[]>(() => api.get("/programs"), []);

  const programList: Program[] = Array.isArray(programs.data) ? programs.data : programs.data?.items ?? [];

  async function act(id: string, action: "approve" | "reject" | "pause") {
    setBusy(id + action);
    setActionErr(null);
    try {
      if (action === "pause") {
        await api.patch(`/affiliates/${id}`, { status: "paused" });
      } else {
        await api.post(`/affiliates/${id}/${action}`, {});
      }
      reload();
    } catch (e: any) {
      setActionErr(e?.message ?? `${action} failed`);
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;

  const items = data?.items ?? [];
  const total = data?.total ?? items.length;
  const counts = items.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        title="Affiliate roster"
        crumb="THE ROSTER"
        subtitle="Every relationship — inbound applicants and recruited prospects alike. Approve who will produce, pause who won't, and keep the partnership ledger clean."
        actions={
          <button className="btn primary" onClick={() => setInviteOpen(true)}>
            + Invite affiliate
          </button>
        }
      />

      {actionErr && <ErrorBanner message={actionErr} />}

      <div className="grid grid-4">
        <Stat label="Total relationships" value={num(total)} foot={`${num(items.length)} shown`} footClass="muted" />
        <Stat label="Active" value={num(counts.active ?? 0)} foot="producing-capable" footClass="muted" />
        <Stat label="Pending review" value={num(counts.pending ?? 0)} foot="awaiting approval" footClass={(counts.pending ?? 0) > 0 ? "warn" : "muted"} />
        <Stat label="Paused / rejected" value={num((counts.paused ?? 0) + (counts.rejected ?? 0))} foot="inactive" footClass="muted" />
      </div>

      <div className="row gap-8 mt-24" style={{ flexWrap: "wrap" }}>
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            className={`btn sm ${status === s ? "primary" : "ghost"}`}
            onClick={() => setStatus(s)}
          >
            {s === "all" ? "All" : s}
            {s !== "all" && counts[s] != null ? ` · ${counts[s]}` : ""}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="">All roles</option>
          <option value="affiliate">Affiliate</option>
          <option value="influencer">Influencer</option>
          <option value="agency">Agency</option>
          <option value="referral">Referral</option>
        </select>
      </div>

      <div className="mt-16">
        {items.length === 0 ? (
          <EmptyState
            title="No affiliates match"
            hint={status === "all" ? "Invite your first partner, or approve recruited prospects from the recruitment engine." : `No relationships in "${status}". Clear the filter to see the full roster.`}
            action={
              status === "all"
                ? <button className="btn primary" onClick={() => setInviteOpen(true)}>Invite affiliate</button>
                : <button className="btn ghost" onClick={() => setStatus("all")}>Clear filter</button>
            }
          />
        ) : (
          <Card flush title={`Relationships · ${items.length}`} sub="inbound + recruited, every status">
            <div style={{ overflow: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Affiliate</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Source</th>
                    <th>Joined</th>
                    <th className="num">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const country = affCountry(r);
                    return (
                      <tr key={r.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{affName(r)}</div>
                          <div className="faint mono" style={{ fontSize: 11 }}>
                            {affEmail(r)}{country ? ` · ${country}` : ""}
                          </div>
                        </td>
                        <td>
                          <Badge kind="info">{r.role ?? "affiliate"}</Badge>
                        </td>
                        <td>
                          <Badge kind={statusKind(r.status)}>{r.status}</Badge>
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>
                          {r.source ? r.source.replace(/_/g, " ") : "—"}
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>{shortDate(r.joinedAt)}</td>
                        <td className="num">
                          <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
                            {r.status === "pending" && (
                              <button className="btn sm primary" disabled={busy === r.id + "approve"} onClick={() => act(r.id, "approve")}>
                                {busy === r.id + "approve" ? "…" : "Approve"}
                              </button>
                            )}
                            {(r.status === "active" || r.status === "pending") && (
                              <button className="btn sm ghost" disabled={busy === r.id + "pause"} onClick={() => act(r.id, "pause")}>
                                {busy === r.id + "pause" ? "…" : "Pause"}
                              </button>
                            )}
                            {r.status !== "rejected" && (
                              <button className="btn sm ghost" disabled={busy === r.id + "reject"} onClick={() => act(r.id, "reject")}>
                                {busy === r.id + "reject" ? "…" : "Reject"}
                              </button>
                            )}
                            <button className="btn sm" onClick={() => navigate("/affiliates/" + r.id)}>
                              View →
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        programs={programList}
        onInvited={() => {
          setInviteOpen(false);
          reload();
        }}
      />
    </>
  );
}

function InviteModal({
  open,
  onClose,
  programs,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  programs: Program[];
  onInvited: () => void;
}) {
  const [form, setForm] = useState({ email: "", name: "", role: "affiliate", programId: "", source: "manual_invite" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api.post("/affiliates", {
        email: form.email,
        name: form.name,
        role: form.role,
        programId: form.programId || (programs[0]?.id ?? ""),
        source: form.source,
      });
      setForm({ email: "", name: "", role: "affiliate", programId: "", source: "manual_invite" });
      onInvited();
    } catch (e: any) {
      setErr(e?.message ?? "invite failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Invite affiliate">
      <div style={{ padding: "4px 20px 20px" }}>
        {err && <ErrorBanner message={err} />}
        <Field label="Email">
          <input
            className="input"
            type="email"
            placeholder="partner@example.com"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </Field>
        <Field label="Name">
          <input
            className="input"
            placeholder="Display name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <div className="grid grid-2">
          <Field label="Role">
            <select className="select" value={form.role} onChange={(e) => set("role", e.target.value)}>
              <option value="affiliate">Affiliate</option>
              <option value="influencer">Influencer</option>
              <option value="agency">Agency</option>
              <option value="referral">Referral</option>
            </select>
          </Field>
          <Field label="Program">
            <select className="select" value={form.programId} onChange={(e) => set("programId", e.target.value)}>
              {programs.length === 0 && <option value="">No programs</option>}
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Source">
          <input
            className="input"
            placeholder="manual_invite"
            value={form.source}
            onChange={(e) => set("source", e.target.value)}
          />
        </Field>
        <div className="row gap-8 mt-16">
          <button
            className="btn primary"
            onClick={submit}
            disabled={busy || !form.email || (programs.length > 0 && !form.programId && !programs[0])}
          >
            {busy ? "inviting…" : "Send invite"}
          </button>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
