import { useState } from "react";
import { api, errorMessage, shortDate } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, Field, statusKind } from "../ui";
import { navigate } from "../router";

// Shapes as the API returns them (`routes/affiliates.ts`, `routes/crm.ts`, the entities).
// The previous interfaces named fields that do not exist (`email`, `createdAt`, `author`),
// so the email line always read "no email on file" and every date rendered as a dash.

interface Affiliate {
  id: string;
  name?: string | null;
  primaryEmail?: string | null;
  country?: string | null;
}

/** `GET /affiliates/:relationshipId` — the relationship, flat, with `affiliate` joined in. */
interface Relationship {
  id: string;
  affiliateId: string;
  programId: string;
  status: string;
  /** seller | recruiter | both */
  role: string;
  tags?: string[] | null;
  joinedAt?: string | null;
  source?: string | null;
  affiliate?: Affiliate | null;
}

interface Note {
  id: string;
  body: string;
  authorId?: string | null;
  ts?: string | null;
}

interface Task {
  id: string;
  title: string;
  status: string;
  dueAt?: string | null;
}

interface Message {
  id: string;
  direction: string;
  channel: string;
  subject?: string | null;
  bodyRef?: string | null;
  ts?: string | null;
}

type Tab = "notes" | "tasks" | "messages";

// The enums the relationship PATCH accepts.
const ROLES = ["seller", "recruiter", "both"];
const STATUSES = ["pending", "active", "paused", "rejected", "banned"];

export function AffiliateDetail({ relationshipId }: { relationshipId: string }) {
  const [tab, setTab] = useState<Tab>("notes");
  const [err, setErr] = useState<string | null>(null);

  const detail = useApi<Relationship | { relationship?: Relationship; affiliate?: Affiliate | null } | null>(
    () => api.get(`/affiliates/${encodeURIComponent(relationshipId)}`),
    [relationshipId],
  );

  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error) return <ErrorBanner message={detail.error} />;
  if (!detail.data) return null;

  // The route answers a flat relationship with `affiliate` joined in; a nested
  // { relationship, affiliate } envelope is tolerated too.
  const raw = detail.data as { relationship?: Relationship; affiliate?: Affiliate | null } & Partial<Relationship>;
  const rel = (raw.relationship ?? raw) as Relationship;
  const aff: Affiliate | null = raw.affiliate ?? rel.affiliate ?? null;

  const name = aff?.name ?? aff?.primaryEmail ?? "Affiliate";
  const tags = rel.tags ?? [];

  async function patchRel(body: Partial<Pick<Relationship, "status" | "role" | "tags">>) {
    setErr(null);
    try {
      await api.patch(`/affiliates/${encodeURIComponent(relationshipId)}`, body);
      detail.reload();
    } catch (e) {
      setErr(errorMessage(e, "update failed"));
    }
  }

  return (
    <>
      <PageHeader
        title={name}
        crumb="CRM · RELATIONSHIP"
        subtitle={aff?.primaryEmail ?? "No email on file."}
        actions={
          <button className="btn ghost" onClick={() => navigate("/affiliates")}>
            ← Back to roster
          </button>
        }
      />

      {err && <ErrorBanner message={err} />}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <Card title="Relationship" sub="status, role, and tags drive routing and payout policy">
          <div className="row gap-8 wrap" style={{ marginTop: 4 }}>
            <Badge kind={statusKind(rel.status)}>{rel.status}</Badge>
            <Badge kind="info">{rel.role}</Badge>
            {tags.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
            {tags.length === 0 && <span className="faint" style={{ fontSize: 12 }}>no tags</span>}
          </div>

          <div className="grid grid-2 mt-16">
            <Field label="Status">
              <select className="select" value={rel.status} onChange={(e) => patchRel({ status: e.target.value })}>
                {(STATUSES.includes(rel.status) ? STATUSES : [rel.status, ...STATUSES]).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="Role">
              <select className="select" value={rel.role} onChange={(e) => patchRel({ role: e.target.value })}>
                {(ROLES.includes(rel.role) ? ROLES : [rel.role, ...ROLES]).map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </Field>
          </div>

          <TagEditor tags={tags} onSave={(next) => patchRel({ tags: next })} />

          <div className="card" style={{ background: "var(--ink-850)", marginTop: 16, padding: 14 }}>
            <div className="row between" style={{ fontSize: 12.5 }}>
              <span className="muted">Affiliate ID</span>
              <span className="mono faint">{rel.affiliateId}</span>
            </div>
            <div className="row between" style={{ fontSize: 12.5, marginTop: 6 }}>
              <span className="muted">Program ID</span>
              <span className="mono faint">{rel.programId}</span>
            </div>
            {rel.joinedAt && (
              <div className="row between" style={{ fontSize: 12.5, marginTop: 6 }}>
                <span className="muted">Joined</span>
                <span className="mono faint">{shortDate(rel.joinedAt)}</span>
              </div>
            )}
            {rel.source && (
              <div className="row between" style={{ fontSize: 12.5, marginTop: 6 }}>
                <span className="muted">Source</span>
                <span className="mono faint">{rel.source}</span>
              </div>
            )}
          </div>
        </Card>

        <Card flush title="Activity" sub="every touch is logged — the relationship is the asset">
          <div className="tabs" style={{ margin: "16px 20px 0" }}>
            <div className={`tab${tab === "notes" ? " active" : ""}`} onClick={() => setTab("notes")}>Notes</div>
            <div className={`tab${tab === "tasks" ? " active" : ""}`} onClick={() => setTab("tasks")}>Tasks</div>
            <div className={`tab${tab === "messages" ? " active" : ""}`} onClick={() => setTab("messages")}>Messages</div>
          </div>
          <div style={{ padding: "0 20px 20px" }}>
            {tab === "notes" && <NotesTab relationshipId={relationshipId} />}
            {tab === "tasks" && <TasksTab relationshipId={relationshipId} />}
            {tab === "messages" && <MessagesTab relationshipId={relationshipId} />}
          </div>
        </Card>
      </div>
    </>
  );
}

function TagEditor({ tags, onSave }: { tags: string[]; onSave: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="row gap-8" style={{ marginTop: 12 }}>
      <input
        className="input"
        placeholder="add a tag…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            onSave([...tags, draft.trim()]);
            setDraft("");
          }
        }}
      />
      <button
        className="btn sm"
        disabled={!draft.trim()}
        onClick={() => {
          onSave([...tags, draft.trim()]);
          setDraft("");
        }}
      >
        Tag
      </button>
    </div>
  );
}

function NotesTab({ relationshipId }: { relationshipId: string }) {
  const notes = useApi<{ items: Note[]; total: number } | Note[]>(() => api.get(`/affiliates/${relationshipId}/notes`), [relationshipId]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const items = Array.isArray(notes.data) ? notes.data : notes.data?.items ?? [];

  async function add() {
    if (!body.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/affiliates/${relationshipId}/notes`, { body: body.trim() });
      setBody("");
      notes.reload();
    } catch (e: any) {
      setErr(e?.message ?? "could not add note");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Field label="New note">
        <textarea className="input" rows={3} placeholder="Logged a call, observed a signal, next step…" value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="row gap-8" style={{ marginTop: 8 }}>
        <button className="btn primary sm" onClick={add} disabled={busy || !body.trim()}>
          {busy ? "saving…" : "Add note"}
        </button>
      </div>
      {err && <ErrorBanner message={err} />}

      <div className="mt-16">
        {notes.loading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="No notes yet" hint="Capture context so the next touch picks up where you left off." />
        ) : (
          items.map((n) => (
            <div className="card" key={n.id} style={{ background: "var(--ink-850)", padding: 14, marginBottom: 10 }}>
              <div style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>{n.body}</div>
              <div className="faint mono" style={{ fontSize: 11, marginTop: 8 }}>
                {shortDate(n.ts)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TasksTab({ relationshipId }: { relationshipId: string }) {
  const tasks = useApi<{ items: Task[]; total: number } | Task[]>(() => api.get(`/affiliates/${relationshipId}/tasks`), [relationshipId]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const items = Array.isArray(tasks.data) ? tasks.data : tasks.data?.items ?? [];

  async function add() {
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/affiliates/${relationshipId}/tasks`, { title: title.trim(), dueAt: null });
      setTitle("");
      tasks.reload();
    } catch (e: any) {
      setErr(e?.message ?? "could not add task");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(t: Task) {
    setErr(null);
    const next = t.status === "done" ? "open" : "done";
    try {
      await api.patch(`/tasks/${t.id}`, { status: next });
      tasks.reload();
    } catch (e: any) {
      setErr(e?.message ?? "could not update task");
    }
  }

  return (
    <div>
      <Field label="New task">
        <input className="input" placeholder="Follow up on terms, send asset pack…" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
      </Field>
      <div className="row gap-8" style={{ marginTop: 8 }}>
        <button className="btn primary sm" onClick={add} disabled={busy || !title.trim()}>
          {busy ? "saving…" : "Add task"}
        </button>
      </div>
      {err && <ErrorBanner message={err} />}

      <div className="mt-16">
        {tasks.loading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="No open tasks" hint="Tasks keep recruitment moving — every relationship should have a next step." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Due</th>
                <th className="num">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => toggle(t)}>
                  <td style={{ textDecoration: t.status === "done" ? "line-through" : undefined, opacity: t.status === "done" ? 0.6 : 1 }}>
                    {t.title}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{shortDate(t.dueAt)}</td>
                  <td className="num">
                    <Badge kind={statusKind(t.status)}>{t.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function MessagesTab({ relationshipId }: { relationshipId: string }) {
  const messages = useApi<{ items: Message[]; total: number } | Message[]>(() => api.get(`/affiliates/${relationshipId}/messages`), [relationshipId]);
  const [subject, setSubject] = useState("");
  const [bodyRef, setBodyRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const items = Array.isArray(messages.data) ? messages.data : messages.data?.items ?? [];

  async function add() {
    if (!subject.trim() || !bodyRef.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/affiliates/${relationshipId}/messages`, {
        direction: "outbound",
        channel: "email",
        subject: subject.trim(),
        // Required by the API (a non-empty string) — it used to be sent as null when
        // left blank, which the route rejects.
        bodyRef: bodyRef.trim(),
      });
      setSubject("");
      setBodyRef("");
      messages.reload();
    } catch (e) {
      setErr(errorMessage(e, "could not log message"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Field label="Subject">
        <input className="input" placeholder="Re: partnership terms" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label="Reference">
        <input className="input" placeholder="where the message lives — a thread link, template id, or a one-line summary" value={bodyRef} onChange={(e) => setBodyRef(e.target.value)} />
      </Field>
      <div className="row gap-8" style={{ marginTop: 8 }}>
        <button className="btn primary sm" onClick={add} disabled={busy || !subject.trim() || !bodyRef.trim()}>
          {busy ? "logging…" : "Log outbound email"}
        </button>
      </div>
      {err && <ErrorBanner message={err} />}

      <div className="mt-16">
        {messages.loading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="No messages logged" hint="Log every outbound touch and inbound reply to keep the thread auditable." />
        ) : (
          items.map((m) => (
            <div className="card" key={m.id} style={{ background: "var(--ink-850)", padding: 14, marginBottom: 10 }}>
              <div className="row between">
                <div className="row gap-8">
                  <Badge kind={m.direction === "outbound" ? "info" : "pos"}>{m.direction}</Badge>
                  <Badge>{m.channel}</Badge>
                </div>
                <span className="faint mono" style={{ fontSize: 11 }}>{shortDate(m.ts)}</span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginTop: 8 }}>{m.subject ?? "(no subject)"}</div>
              {m.bodyRef && <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>ref: {m.bodyRef}</div>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
