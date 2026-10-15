import { useMemo, useState } from "react";
import { api, errorMessage, num, shortDate } from "../api";
import { useApi, Card, Stat, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, Field, Modal, statusKind, humanize } from "../ui";
import { navigate } from "../router";
import { BulkImport } from "../BulkImport";

interface AffiliateObj {
  name?: string | null;
  primaryEmail?: string | null;
  country?: string | null;
}

interface Relationship {
  id: string;
  affiliateId: string;
  status: string;
  role?: string | null;
  tags?: string[] | null;
  joinedAt?: string | null;
  source?: string | null;
  /** Joined in by the list route; null when the global affiliate row is gone. */
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
  status?: string;
}

// The relationship statuses and roles the API accepts (`routes/affiliates.ts`).
const STATUS_FILTERS = ["all", "active", "pending", "paused", "rejected", "banned"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** `role` is what the affiliate does in the program, not what kind of creator they are. */
const ROLE_OPTIONS: { value: "seller" | "recruiter" | "both"; label: string }[] = [
  { value: "seller", label: "Seller — earns on their own sales" },
  { value: "recruiter", label: "Recruiter — earns on recruits' sales" },
  { value: "both", label: "Both" },
];

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
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: "100" });
    if (status !== "all") p.set("status", status);
    if (role) p.set("role", role);
    return p.toString();
  }, [status, role]);

  const { data, loading, error, reload } = useApi<{ items?: Relationship[]; total?: number } | null>(
    () => api.get(`/affiliates?${qs}`),
    [qs]
  );
  const programs = useApi<{ items?: Program[]; total?: number } | Program[] | null>(() => api.get("/programs"), []);

  const programList: Program[] = Array.isArray(programs.data) ? programs.data : programs.data?.items ?? [];
  // The roster import attaches everyone to a program; with none, the API skips every row.
  const noPrograms = !programs.loading && !programs.error && programList.length === 0;

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
    } catch (e) {
      setActionErr(errorMessage(e, `${action} failed`));
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;

  const items = data?.items ?? [];
  const total = data?.total ?? items.length;
  const counts = items.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const inactive = (counts.paused ?? 0) + (counts.rejected ?? 0) + (counts.banned ?? 0);

  return (
    <>
      <PageHeader
        title="Affiliate roster"
        crumb="THE ROSTER"
        subtitle="Every relationship — inbound applicants and recruited prospects alike. Approve who will produce, pause who won't, and keep the partnership ledger clean."
        actions={
          <>
            <button className="btn" onClick={() => setImportOpen((v) => !v)}>
              {importOpen ? "Close import" : "⇪ Import roster"}
            </button>
            <button className="btn primary" onClick={() => setInviteOpen(true)}>
              + Add affiliate
            </button>
          </>
        }
      />

      {importOpen && (
        <BulkImport
          kind="roster"
          onClose={() => setImportOpen(false)}
          onImported={reload}
          blocked={
            noPrograms ? (
              <>
                You need a program before importing a roster — every imported affiliate is attached to one.{" "}
                <a href="#/programs" style={{ textDecoration: "underline" }}>Create a program</a>, then come back.
              </>
            ) : undefined
          }
        />
      )}

      {actionErr && <ErrorBanner message={actionErr} />}

      <div className="grid grid-4">
        <Stat label="Total relationships" value={num(total)} foot={`${num(items.length)} shown`} footClass="muted" />
        <Stat label="Active" value={num(counts.active ?? 0)} foot="producing-capable" footClass="muted" />
        <Stat label="Pending review" value={num(counts.pending ?? 0)} foot="awaiting approval" footClass={(counts.pending ?? 0) > 0 ? "warn" : "muted"} />
        <Stat label="Paused / rejected / banned" value={num(inactive)} foot="inactive" footClass="muted" />
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
        <select className="select" value={role} onChange={(e) => setRole(e.target.value)} style={{ maxWidth: 180 }} aria-label="Filter by role">
          <option value="">All roles</option>
          <option value="seller">Seller</option>
          <option value="recruiter">Recruiter</option>
          <option value="both">Both</option>
        </select>
      </div>

      <div className="mt-16">
        {items.length === 0 ? (
          <EmptyState
            title="No affiliates match"
            hint={
              status === "all" && !role
                ? "Add your first partner, import the roster you already have, or approve recruited prospects from the recruitment engine."
                : "No relationships match these filters. Clear them to see the full roster."
            }
            action={
              status === "all" && !role ? (
                <div className="row gap-8" style={{ justifyContent: "center" }}>
                  <button className="btn primary" onClick={() => setInviteOpen(true)}>Add affiliate</button>
                  <button className="btn" onClick={() => setImportOpen(true)}>Import roster</button>
                </div>
              ) : (
                <button className="btn ghost" onClick={() => { setStatus("all"); setRole(""); }}>Clear filters</button>
              )
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
                          <Badge kind="info">{r.role ?? "seller"}</Badge>
                        </td>
                        <td>
                          <Badge kind={statusKind(r.status)}>{r.status}</Badge>
                        </td>
                        <td className="muted" style={{ fontSize: 12 }}>
                          {humanize(r.source)}
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
  const blank = { email: "", name: "", role: "seller", programId: "", source: "manual_invite" };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  // The select shows the first program when none was picked, so submit that one.
  const programId = form.programId || programs[0]?.id || "";
  const email = form.email.trim();

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api.post("/affiliates", {
        email,
        // The API requires a name; default to the mailbox name rather than failing.
        name: form.name.trim() || email.split("@")[0] || email,
        role: form.role,
        programId,
        source: form.source.trim() || undefined,
      });
      setForm(blank);
      onInvited();
    } catch (e) {
      setErr(errorMessage(e, "Could not add the affiliate."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add affiliate">
      <div style={{ padding: "4px 0" }}>
        {err && <ErrorBanner message={err} />}
        {programs.length === 0 && (
          <ErrorBanner message="Create a program first (Programs & Offers) — an affiliate is always added to a program." />
        )}
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
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Program">
            <select className="select" value={programId} onChange={(e) => set("programId", e.target.value)}>
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
        <div className="faint" style={{ fontSize: 11.5 }}>
          They are added as an active affiliate straight away. No email is sent — they sign in to the portal by requesting a
          link with this address.
        </div>
        <div className="row gap-8 mt-16">
          <button className="btn primary" onClick={submit} disabled={busy || !email || !programId}>
            {busy ? "adding…" : "Add affiliate"}
          </button>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
