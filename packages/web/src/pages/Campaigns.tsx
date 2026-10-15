import { useState } from "react";
import { api } from "../api";
import { useApi, Card, Badge, PageHeader, EmptyState, Field, Stat, statusKind } from "../ui";

// ---- shapes (match packages/db/src/entities.ts) -----------------------------
type Channel = "email" | "dm" | "contact_form";
interface SequenceStep {
  step: number;
  delayDays: number;
  subject: string;
  body: string;
  kind: "initial" | "follow_up" | "breakup";
  channel?: Channel;
}
interface SendWindow { startHour: number; endHour: number; timezone: string }
interface Campaign {
  id: string;
  merchantId: string;
  mailboxId: string | null;
  sendingDomainId: string | null;
  name: string;
  sequence?: SequenceStep[] | null;
  sendWindow?: SendWindow | null;
  dailyCap: number;
  status: "draft" | "active" | "paused" | "archived";
}
interface Mailbox { id: string; provider: string; email: string; status: string }
interface ScanIssue { code: string; message: string; severity: "warn" | "block" }
interface ScanResult { ok: boolean; severity: "clean" | "warn" | "block"; score: number; issues: ScanIssue[] }
interface LaunchSummary { queued: number; sent: number; bounced: number; skipped: number; deferred: number; blockedReason?: string }

const MAX_STEPS = 4; // backend caps at 1 initial + 3 follow-ups (MAX_FOLLOWUPS = 3)
const TOKENS = "{{name}} · {{merchant}} · {{offer}} · {{angle}}";

// ---- three cloneable starter cadences (plain arrays of steps) ---------------
const TEMPLATES: { name: string; hint: string; steps: SequenceStep[] }[] = [
  {
    name: "Competitor-affiliate recruit (3-touch)",
    hint: "Warmest cold cadence: pitch → nudge → graceful breakup.",
    steps: [
      { step: 1, delayDays: 0, kind: "initial", channel: "email", subject: "Partner with {{merchant}}?", body: "Hi {{name}},\n\n{{angle}} I run the affiliate program at {{merchant}} and think {{offer}} would land well with your audience.\n\nOpen to a quick look at the terms?\n\nBest" },
      { step: 2, delayDays: 3, kind: "follow_up", channel: "email", subject: "Re: Partner with {{merchant}}?", body: "Hi {{name}}, floating this back to the top of your inbox — happy to send the commission details on {{offer}} whenever you have a minute." },
      { step: 3, delayDays: 7, kind: "breakup", channel: "email", subject: "Closing the loop", body: "No worries if it's not a fit, {{name}} — I'll leave the door open. Reply anytime and I'll get you set up with {{merchant}}." },
    ],
  },
  {
    name: "Creator collab (email → DM)",
    hint: "Content-first tone, with a DM step for creators who live in their inbox less.",
    steps: [
      { step: 1, delayDays: 0, kind: "initial", channel: "email", subject: "Loved your recent work, {{name}}", body: "Hi {{name}},\n\n{{angle}} We'd love to have you in the {{merchant}} creator program — {{offer}}, paid on every sale you drive.\n\nWant me to send a sample link?" },
      { step: 2, delayDays: 4, kind: "follow_up", channel: "email", subject: "Re: Loved your recent work", body: "Circling back, {{name}} — the {{merchant}} program is quick to set up and there's no exclusivity. Keen to see the details?" },
      { step: 3, delayDays: 7, kind: "breakup", channel: "dm", subject: "", body: "Hey {{name}} — tried your inbox re: the {{merchant}} program. If DMs are easier, happy to send everything here." },
    ],
  },
  {
    name: "Quick 2-touch",
    hint: "Minimal footprint: a single ask plus one nudge.",
    steps: [
      { step: 1, delayDays: 0, kind: "initial", channel: "email", subject: "{{offer}} with {{merchant}}", body: "Hi {{name}}, {{angle}} — would {{offer}} be interesting for your audience? Happy to set you up in minutes." },
      { step: 2, delayDays: 5, kind: "follow_up", channel: "email", subject: "Re: {{offer}} with {{merchant}}", body: "Quick nudge, {{name}} — still glad to get you started with {{merchant}} whenever works." },
    ],
  },
];

const TZ_OPTIONS = ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Singapore", "Australia/Sydney"];

function renumber(steps: SequenceStep[]): SequenceStep[] {
  return steps.map((s, i) => ({ ...s, step: i + 1, kind: i === 0 ? "initial" : s.kind === "initial" ? "follow_up" : s.kind }));
}

export function Campaigns() {
  const campaigns = useApi<Campaign[]>(() => api.get("/recruitment/campaigns"));
  const mailboxes = useApi<Mailbox[]>(() => api.get("/mailboxes"));

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const list = campaigns.data ?? [];
  const boxes = mailboxes.data ?? [];
  const selected = list.find((c) => c.id === selectedId) ?? null;

  return (
    <>
      <PageHeader
        title="Campaigns & sequences"
        crumb="OUTREACH · THE CORE LOOP"
        subtitle="Build the multi-step cadence the engine sends as you: subject + body per step with {{tokens}}, delays, an email-or-DM channel, a send window and daily cap. Check each step against the spam gate, then launch to your scored prospects."
        actions={<button className="btn primary sm" onClick={() => { setCreating((v) => !v); setErr(null); }}>{creating ? "Close" : "＋ New campaign"}</button>}
      />

      {err && <div className="err-banner">{err}</div>}

      {creating && (
        <NewCampaignForm
          boxes={boxes}
          onCancel={() => setCreating(false)}
          onCreated={(c) => { setCreating(false); campaigns.reload(); setSelectedId(c.id); }}
          onError={setErr}
        />
      )}

      <div className="grid grid-3">
        <Stat label="Campaigns" value={list.length} foot="across statuses" footClass="muted" />
        <Stat label="Active" value={list.filter((c) => c.status === "active").length} foot="sending now" footClass="muted" small />
        <Stat label="Mailboxes" value={boxes.length} foot="available senders" footClass="muted" small />
      </div>

      {campaigns.error && <div className="err-banner">{campaigns.error}</div>}

      <div className="mt-24">
        <Card flush title="Your campaigns" sub="pick one to edit its sequence, launch, or seed-test">
          {campaigns.loading ? null : list.length === 0 ? (
            <div style={{ padding: "0 20px 18px" }}>
              <EmptyState title="No campaigns yet" hint="Create one from a starter template above — it becomes the cadence the autonomous engine sends through." />
            </div>
          ) : (
            <table className="table">
              <thead><tr><th>Name</th><th>Status</th><th className="num">Steps</th><th>Mailbox</th><th className="num" /></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} style={selectedId === c.id ? { background: "var(--ink-850)" } : undefined}>
                    <td><div style={{ fontWeight: 600 }}>{c.name}</div><div className="faint mono" style={{ fontSize: 11 }}>{c.id}</div></td>
                    <td><Badge kind={statusKind(c.status)}>{c.status}</Badge></td>
                    <td className="num mono">{c.sequence?.length ?? 0}</td>
                    <td className="muted mono" style={{ fontSize: 12 }}>{boxes.find((b) => b.id === c.mailboxId)?.email ?? "—"}</td>
                    <td className="num"><button className="btn sm" onClick={() => setSelectedId(selectedId === c.id ? null : c.id)}>{selectedId === c.id ? "Close" : "Edit"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {selected && (
        <CampaignEditor
          key={selected.id}
          campaign={selected}
          boxes={boxes}
          onSaved={() => campaigns.reload()}
        />
      )}
    </>
  );
}

// ---- New campaign -----------------------------------------------------------
function NewCampaignForm({ boxes, onCancel, onCreated, onError }: { boxes: Mailbox[]; onCancel: () => void; onCreated: (c: Campaign) => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [mailboxId, setMailboxId] = useState<string>("");
  const [templateIdx, setTemplateIdx] = useState(0);
  const [win, setWin] = useState<SendWindow>({ startHour: 9, endHour: 17, timezone: "UTC" });
  const [dailyCap, setDailyCap] = useState(50);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) { onError("Give the campaign a name."); return; }
    setBusy(true); onError("");
    try {
      const c = await api.post<Campaign>("/recruitment/campaigns", {
        name: name.trim(),
        mailboxId: mailboxId || null,
        sequence: renumber(TEMPLATES[templateIdx].steps),
        sendWindow: win,
        dailyCap,
      });
      onCreated(c);
    } catch (e: any) { onError(e?.message ?? "could not create campaign"); }
    finally { setBusy(false); }
  }

  return (
    <Card title="New campaign" sub="seed from a starter cadence — you can edit every step after">
      <div className="grid grid-2 mt-16">
        <Field label="Name"><input className="input" placeholder="Q3 Competitor Affiliates" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Sending mailbox">
          <select className="select" value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
            <option value="">— none (set before launch) —</option>
            {boxes.map((b) => <option key={b.id} value={b.id}>{b.email}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Starter template">
        <select className="select" value={templateIdx} onChange={(e) => setTemplateIdx(Number(e.target.value))}>
          {TEMPLATES.map((t, i) => <option key={t.name} value={i}>{t.name} ({t.steps.length} steps)</option>)}
        </select>
      </Field>
      <p className="faint" style={{ fontSize: 12, marginTop: -6 }}>{TEMPLATES[templateIdx].hint}</p>
      <div className="grid grid-4 mt-16" style={{ alignItems: "end" }}>
        <Field label="Send from (hour, local to TZ)"><input className="input" type="number" min={0} max={23} value={win.startHour} onChange={(e) => setWin({ ...win, startHour: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
        <Field label="Send until (hour)"><input className="input" type="number" min={0} max={23} value={win.endHour} onChange={(e) => setWin({ ...win, endHour: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
        <Field label="Timezone"><select className="select" value={win.timezone} onChange={(e) => setWin({ ...win, timezone: e.target.value })}>{TZ_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
        <Field label="Daily cap"><input className="input" type="number" min={1} value={dailyCap} onChange={(e) => setDailyCap(Math.max(1, Number(e.target.value) || 1))} /></Field>
      </div>
      <div className="row gap-8 mt-16">
        <button className="btn primary" onClick={create} disabled={busy}>{busy ? "creating…" : "Create campaign"}</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </Card>
  );
}

// ---- Editor -----------------------------------------------------------------
function CampaignEditor({ campaign, boxes, onSaved }: { campaign: Campaign; boxes: Mailbox[]; onSaved: () => void }) {
  const [steps, setSteps] = useState<SequenceStep[]>(campaign.sequence?.length ? campaign.sequence : renumber(TEMPLATES[0].steps));
  const [dailyCap, setDailyCap] = useState(campaign.dailyCap);
  const [status, setStatus] = useState(campaign.status);
  const [scan, setScan] = useState<Record<number, ScanResult>>({});
  const [scanBusy, setScanBusy] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // launch
  const [minTier, setMinTier] = useState<"A" | "B" | "C">("C");
  const [max, setMax] = useState(50);
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<LaunchSummary | null>(null);

  // seed test
  const [seeds, setSeeds] = useState("");
  const [seedBusy, setSeedBusy] = useState(false);
  const [seedResult, setSeedResult] = useState<{ results: { seed: string; status: string }[]; note: string } | null>(null);
  const [seedErr, setSeedErr] = useState<string | null>(null);

  function patchStep(i: number, patch: Partial<SequenceStep>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
    setScan((prev) => { const n = { ...prev }; delete n[i]; return n; });
  }
  function addStep() {
    if (steps.length >= MAX_STEPS) return;
    setSteps((prev) => renumber([...prev, { step: prev.length + 1, delayDays: 5, subject: "", body: "", kind: "follow_up", channel: "email" }]));
  }
  function removeStep(i: number) {
    setSteps((prev) => renumber(prev.filter((_, idx) => idx !== i)));
    setScan({});
  }
  function applyTemplate(idx: number) {
    setSteps(renumber(TEMPLATES[idx].steps));
    setScan({});
  }

  async function checkStep(i: number) {
    setScanBusy(i);
    try {
      const r = await api.post<ScanResult>("/recruitment/content-scan", { subject: steps[i].subject, body: steps[i].body });
      setScan((prev) => ({ ...prev, [i]: r }));
    } catch { /* ignore — non-blocking preview */ }
    finally { setScanBusy(null); }
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api.patch(`/recruitment/campaigns/${campaign.id}`, { sequence: renumber(steps), dailyCap, status });
      setMsg({ ok: true, text: "Saved." });
      onSaved();
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? "could not save" }); }
    finally { setBusy(false); }
  }

  async function launch() {
    setLaunching(true); setLaunchResult(null); setMsg(null);
    try {
      const r = await api.post<LaunchSummary>(`/recruitment/campaigns/${campaign.id}/launch`, { minTier, max });
      setLaunchResult(r);
      onSaved();
    } catch (e: any) { setMsg({ ok: false, text: e?.message ?? "launch failed" }); }
    finally { setLaunching(false); }
  }

  async function seedTest() {
    const list = seeds.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) { setSeedErr("Add at least one seed inbox address."); return; }
    setSeedBusy(true); setSeedErr(null); setSeedResult(null);
    try {
      const r = await api.post<{ results: { seed: string; status: string }[]; note: string }>(`/recruitment/campaigns/${campaign.id}/seed-test`, { seeds: list });
      setSeedResult(r);
    } catch (e: any) { setSeedErr(e?.message ?? "seed test failed"); }
    finally { setSeedBusy(false); }
  }

  const mailbox = boxes.find((b) => b.id === campaign.mailboxId);

  return (
    <div className="mt-24">
      <Card
        title={`Editing · ${campaign.name}`}
        sub="the cadence the engine sends as you"
        actions={
          <div className="row gap-8" style={{ alignItems: "center" }}>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as Campaign["status"])}>
              <option value="draft">draft</option>
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="archived">archived</option>
            </select>
            <button className="btn primary sm" onClick={save} disabled={busy}>{busy ? "saving…" : "Save"}</button>
          </div>
        }
      >
        {msg && <div className={msg.ok ? "acc" : "neg"} style={{ fontSize: 13, marginTop: 12 }}>{msg.text}</div>}

        <div className="grid grid-4 mt-16" style={{ alignItems: "end" }}>
          <Field label="Daily cap"><input className="input" type="number" min={1} value={dailyCap} onChange={(e) => setDailyCap(Math.max(1, Number(e.target.value) || 1))} /></Field>
          <div><div className="field"><label>Send window</label><div className="mono faint" style={{ fontSize: 12 }}>{campaign.sendWindow ? `${campaign.sendWindow.startHour}:00–${campaign.sendWindow.endHour}:00 ${campaign.sendWindow.timezone}` : "not set"}</div></div></div>
          <div><div className="field"><label>Mailbox</label><div className="mono faint" style={{ fontSize: 12 }}>{mailbox?.email ?? "none set"}</div></div></div>
          <div className="faint" style={{ fontSize: 11 }}>Send window &amp; mailbox are set at creation.</div>
        </div>

        <div className="row wrap gap-8 mt-16" style={{ alignItems: "center" }}>
          <span className="faint" style={{ fontSize: 12 }}>Replace with a template:</span>
          {TEMPLATES.map((t, i) => <button key={t.name} className="btn sm ghost" onClick={() => applyTemplate(i)}>{t.name.split(" (")[0]}</button>)}
        </div>

        <div className="faint" style={{ fontSize: 12, margin: "14px 0 8px" }}>Tokens available in subject + body: <span className="mono acc">{TOKENS}</span>. Cadence is capped at {MAX_STEPS} steps (1 initial + 3 follow-ups).</div>

        <div className="grid" style={{ gap: 12 }}>
          {steps.map((s, i) => {
            const r = scan[i];
            return (
              <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 14, background: "var(--ink-850)" }}>
                <div className="row wrap gap-8" style={{ justifyContent: "space-between", alignItems: "center" }}>
                  <div className="row wrap gap-8" style={{ alignItems: "center" }}>
                    <Badge kind="info">step {i + 1}</Badge>
                    <Badge>{i === 0 ? "initial" : s.kind}</Badge>
                    <select className="select" style={{ width: 110 }} value={s.channel ?? "email"} onChange={(e) => patchStep(i, { channel: e.target.value as Channel })}>
                      <option value="email">email</option>
                      <option value="dm">dm</option>
                    </select>
                    <label className="row gap-8 faint" style={{ fontSize: 12 }}>
                      delay
                      <input className="input" type="number" min={0} max={60} value={s.delayDays} onChange={(e) => patchStep(i, { delayDays: Math.max(0, Number(e.target.value) || 0) })} style={{ width: 70 }} disabled={i === 0} />
                      days
                    </label>
                  </div>
                  <div className="row gap-8">
                    <button className="btn sm ghost" onClick={() => checkStep(i)} disabled={scanBusy === i}>{scanBusy === i ? "checking…" : "Check"}</button>
                    {steps.length > 1 && <button className="btn sm danger" onClick={() => removeStep(i)}>Remove</button>}
                  </div>
                </div>

                <div className="mt-16">
                  <Field label={s.channel === "dm" ? "Subject (unused for DM)" : "Subject"}>
                    <input className="input" value={s.subject} placeholder="Partner with {{merchant}}?" onChange={(e) => patchStep(i, { subject: e.target.value })} />
                  </Field>
                  <Field label="Body">
                    <textarea className="input" rows={4} value={s.body} placeholder="Hi {{name}}, {{angle}} …" onChange={(e) => patchStep(i, { body: e.target.value })} style={{ width: "100%", resize: "vertical" }} />
                  </Field>
                </div>

                {r && (
                  <div className="row wrap gap-8" style={{ alignItems: "center", marginTop: 4 }}>
                    <Badge kind={r.severity === "clean" ? "pos" : r.severity === "warn" ? "warn" : "neg"}>{r.severity === "clean" ? "✓ clean" : r.severity === "warn" ? "warn" : "block"}</Badge>
                    <span className="faint" style={{ fontSize: 12 }}>spam score {r.score}</span>
                    {r.issues.map((iss, k) => (
                      <span key={k} className={iss.severity === "block" ? "neg" : "warn"} style={{ fontSize: 12 }}>{iss.message}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-16">
          <button className="btn sm" onClick={addStep} disabled={steps.length >= MAX_STEPS}>＋ Add step{steps.length >= MAX_STEPS ? " (max reached)" : ""}</button>
        </div>
      </Card>

      <div className="grid grid-2 mt-24">
        <Card title="Launch" sub="send the first touch to your scored prospects now">
          <div className="grid grid-2 mt-16" style={{ alignItems: "end" }}>
            <Field label="Minimum tier">
              <select className="select" value={minTier} onChange={(e) => setMinTier(e.target.value as "A" | "B" | "C")}>
                <option value="A">A only</option>
                <option value="B">A + B</option>
                <option value="C">All tiers</option>
              </select>
            </Field>
            <Field label="Max to send"><input className="input" type="number" min={1} value={max} onChange={(e) => setMax(Math.max(1, Number(e.target.value) || 1))} /></Field>
          </div>
          <button className="btn primary mt-16" onClick={launch} disabled={launching}>{launching ? "launching…" : "▶ Launch campaign"}</button>
          <p className="faint" style={{ fontSize: 12 }}>Respects the send window, daily cap, and deliverability circuit breaker. Local-send-time optimization is on.</p>
          {launchResult && (
            <div className="row wrap gap-8 mt-16">
              <Badge kind="info">queued {launchResult.queued}</Badge>
              <Badge kind="pos">sent {launchResult.sent}</Badge>
              {launchResult.bounced > 0 && <Badge kind="neg">bounced {launchResult.bounced}</Badge>}
              <Badge kind="warn">skipped {launchResult.skipped}</Badge>
              <Badge>deferred {launchResult.deferred}</Badge>
              {launchResult.blockedReason && <Badge kind="neg">blocked: {launchResult.blockedReason}</Badge>}
            </div>
          )}
        </Card>

        <Card title="Seed / placement test" sub="send the first touch to your own seed inboxes to check primary-vs-spam">
          <Field label="Seed inboxes (comma / newline separated)">
            <textarea className="input" rows={3} value={seeds} placeholder={"you@gmail.com\nyou@outlook.com"} onChange={(e) => setSeeds(e.target.value)} style={{ width: "100%", resize: "vertical" }} />
          </Field>
          <button className="btn mt-8" onClick={seedTest} disabled={seedBusy}>{seedBusy ? "sending…" : "Send seed test"}</button>
          {seedErr && <div className="neg" style={{ fontSize: 12, marginTop: 8 }}>{seedErr}</div>}
          {seedResult && (
            <div className="mt-16">
              <div className="row wrap gap-8">
                {seedResult.results.map((s) => <Badge key={s.seed} kind={statusKind(s.status)}>{s.seed}: {s.status}</Badge>)}
              </div>
              <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>{seedResult.note}</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
