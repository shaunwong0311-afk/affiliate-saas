import { useState } from "react";
import { api, shortDate } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, Field, Modal, statusKind } from "../ui";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

interface CreatedKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  key: string;
}

interface Webhook {
  id: string;
  url: string;
  events: string[];
  status: string;
}

interface Delivery {
  eventType: string;
  targetUrl: string;
  status: string;
  attempts: number;
  ts: string;
}

const SCOPES = ["read", "write"];
const EVENT_CHOICES = [
  "conversion.created",
  "conversion.reversed",
  "payout.paid",
  "payout.failed",
  "affiliate.created",
  "click.recorded",
];

export function Developer() {
  const keys = useApi<ApiKey[]>(() => api.get("/developer/api-keys"));
  const hooks = useApi<Webhook[]>(() => api.get("/developer/webhooks"));
  const deliveries = useApi<Delivery[]>(() => api.get("/developer/webhook-deliveries"));

  const [keyOpen, setKeyOpen] = useState(false);
  const [keyForm, setKeyForm] = useState<{ name: string; scopes: string[] }>({ name: "", scopes: ["read"] });
  const [keyBusy, setKeyBusy] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);

  const [hookOpen, setHookOpen] = useState(false);
  const [hookForm, setHookForm] = useState<{ url: string; events: string[] }>({ url: "", events: [] });
  const [hookBusy, setHookBusy] = useState(false);

  const [err, setErr] = useState<string | null>(null);

  function toggleScope(s: string) {
    setKeyForm((f) => ({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] }));
  }

  function toggleEvent(e: string) {
    setHookForm((f) => ({ ...f, events: f.events.includes(e) ? f.events.filter((x) => x !== e) : [...f.events, e] }));
  }

  async function createKey() {
    setKeyBusy(true);
    setErr(null);
    try {
      const res = await api.post<CreatedKey>("/developer/api-keys", { name: keyForm.name, scopes: keyForm.scopes.length ? keyForm.scopes : ["read"] });
      setCreated(res);
      setKeyOpen(false);
      setKeyForm({ name: "", scopes: ["read"] });
      keys.reload();
    } catch (e: any) {
      setErr(e?.message ?? "could not create key");
    } finally {
      setKeyBusy(false);
    }
  }

  async function revokeKey(k: ApiKey) {
    setErr(null);
    try {
      await api.del(`/developer/api-keys/${k.id}`);
      keys.reload();
    } catch (e: any) {
      setErr(e?.message ?? "could not revoke key");
    }
  }

  async function createHook() {
    setHookBusy(true);
    setErr(null);
    try {
      await api.post("/developer/webhooks", { url: hookForm.url, events: hookForm.events });
      setHookOpen(false);
      setHookForm({ url: "", events: [] });
      hooks.reload();
    } catch (e: any) {
      setErr(e?.message ?? "could not create webhook");
    } finally {
      setHookBusy(false);
    }
  }

  async function deleteHook(h: Webhook) {
    setErr(null);
    try {
      await api.del(`/developer/webhooks/${h.id}`);
      hooks.reload();
    } catch (e: any) {
      setErr(e?.message ?? "could not delete webhook");
    }
  }

  if (keys.loading) return <Spinner />;
  if (keys.error) return <ErrorBanner message={keys.error} />;

  const keyItems = keys.data ?? [];
  const hookItems = hooks.data ?? [];
  const deliveryItems = deliveries.data ?? [];

  return (
    <>
      <PageHeader
        title="Developer"
        crumb="API · WEBHOOKS"
        subtitle="Programmatic access to the platform. Mint scoped API keys, subscribe webhooks to lifecycle events, and inspect every delivery attempt."
        actions={
          <button className="btn primary" onClick={() => setKeyOpen(true)}>
            ＋ New API key
          </button>
        }
      />

      {err && <ErrorBanner message={err} />}

      {created && (
        <div
          className="err-banner"
          style={{ background: "var(--acc-glow)", borderColor: "var(--acc-dim)", color: "var(--acc)", display: "block" }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Copy your new key now — it will not be shown again.</div>
          <div className="mono" style={{ fontSize: 13, wordBreak: "break-all", marginBottom: 8 }}>{created.key}</div>
          <div className="row gap-8">
            <button
              className="btn sm"
              onClick={() => navigator.clipboard?.writeText(created.key)}
            >
              Copy key
            </button>
            <button className="btn sm ghost" onClick={() => setCreated(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <Card flush title={`API keys · ${keyItems.length}`} sub="scoped credentials — the plaintext secret is shown only at creation">
        {keyItems.length === 0 ? (
          <div style={{ padding: "0 20px 18px" }}>
            <EmptyState
              title="No API keys"
              hint="Create a key to authenticate server-to-server requests against the platform API."
              action={<button className="btn primary" onClick={() => setKeyOpen(true)}>New API key</button>}
            />
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>Created</th>
                <th className="num"></th>
              </tr>
            </thead>
            <tbody>
              {keyItems.map((k) => (
                <tr key={k.id}>
                  <td style={{ fontWeight: 600 }}>{k.name}</td>
                  <td className="mono faint" style={{ fontSize: 12 }}>{k.prefix}…</td>
                  <td>
                    <div className="row gap-8">
                      {k.scopes.map((s) => (
                        <Badge key={s} kind="info">{s}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{shortDate(k.lastUsedAt)}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{shortDate(k.createdAt)}</td>
                  <td className="num">
                    {k.revokedAt ? (
                      <Badge kind="neg">revoked</Badge>
                    ) : (
                      <button className="btn sm danger" onClick={() => revokeKey(k)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="mt-24">
        <Card
          flush
          title={`Webhooks · ${hookItems.length}`}
          sub="push lifecycle events to your endpoints"
          actions={<button className="btn sm" onClick={() => setHookOpen(true)}>＋ Add endpoint</button>}
        >
          {hooks.error ? (
            <div style={{ padding: "0 20px 18px" }}>
              <ErrorBanner message={hooks.error} />
            </div>
          ) : hookItems.length === 0 ? (
            <div style={{ padding: "0 20px 18px" }}>
              <EmptyState
                title="No webhook endpoints"
                hint="Subscribe an HTTPS endpoint to events like conversion.created or payout.paid."
                action={<button className="btn primary" onClick={() => setHookOpen(true)}>Add endpoint</button>}
              />
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Events</th>
                  <th>Status</th>
                  <th className="num"></th>
                </tr>
              </thead>
              <tbody>
                {hookItems.map((h) => (
                  <tr key={h.id}>
                    <td className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{h.url}</td>
                    <td>
                      <div className="row gap-8" style={{ flexWrap: "wrap" }}>
                        {h.events.map((e) => (
                          <Badge key={e}>{e}</Badge>
                        ))}
                      </div>
                    </td>
                    <td>
                      <Badge kind={statusKind(h.status)}>{h.status}</Badge>
                    </td>
                    <td className="num">
                      <button className="btn sm danger" onClick={() => deleteHook(h)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="mt-24">
        <Card flush title="Recent deliveries" sub="every attempt, with status and retry count">
          {deliveries.loading ? (
            <div style={{ padding: "0 20px 18px" }}>
              <Spinner />
            </div>
          ) : deliveries.error ? (
            <div style={{ padding: "0 20px 18px" }}>
              <ErrorBanner message={deliveries.error} />
            </div>
          ) : deliveryItems.length === 0 ? (
            <div style={{ padding: "0 20px 18px" }}>
              <EmptyState title="No deliveries yet" hint="Delivery attempts appear here once events fire against your endpoints." />
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Target</th>
                  <th>Status</th>
                  <th className="num">Attempts</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {deliveryItems.map((d, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ fontSize: 12 }}>{d.eventType}</td>
                    <td className="mono faint" style={{ fontSize: 12, wordBreak: "break-all" }}>{d.targetUrl}</td>
                    <td>
                      <Badge kind={statusKind(d.status)}>{d.status}</Badge>
                    </td>
                    <td className="num">{d.attempts}</td>
                    <td className="muted" style={{ fontSize: 12 }}>{shortDate(d.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Modal open={keyOpen} onClose={() => setKeyOpen(false)} title="Create API key">
        <Field label="Name">
          <input
            className="input"
            placeholder="e.g. Production server"
            value={keyForm.name}
            onChange={(e) => setKeyForm((f) => ({ ...f, name: e.target.value }))}
          />
        </Field>
        <Field label="Scopes">
          <div className="row gap-8">
            {SCOPES.map((s) => (
              <label key={s} className="row gap-8" style={{ cursor: "pointer", fontSize: 13 }}>
                <input type="checkbox" checked={keyForm.scopes.includes(s)} onChange={() => toggleScope(s)} />
                <span className="mono">{s}</span>
              </label>
            ))}
          </div>
        </Field>
        <div className="row gap-8 mt-16">
          <button className="btn primary" onClick={createKey} disabled={keyBusy || !keyForm.name.trim()}>
            {keyBusy ? "creating…" : "Create key"}
          </button>
          <button className="btn ghost" onClick={() => setKeyOpen(false)}>Cancel</button>
        </div>
      </Modal>

      <Modal open={hookOpen} onClose={() => setHookOpen(false)} title="Add webhook endpoint">
        <Field label="Endpoint URL">
          <input
            className="input"
            placeholder="https://example.com/webhooks/vantage"
            value={hookForm.url}
            onChange={(e) => setHookForm((f) => ({ ...f, url: e.target.value }))}
          />
        </Field>
        <Field label="Events">
          <div className="row gap-8" style={{ flexWrap: "wrap" }}>
            {EVENT_CHOICES.map((e) => {
              const on = hookForm.events.includes(e);
              return (
                <button
                  key={e}
                  type="button"
                  className={`badge ${on ? "info" : ""}`}
                  style={{ cursor: "pointer", background: on ? undefined : "var(--ink-850)" }}
                  onClick={() => toggleEvent(e)}
                >
                  {on ? "✓ " : "＋ "}{e}
                </button>
              );
            })}
          </div>
        </Field>
        <div className="row gap-8 mt-16">
          <button
            className="btn primary"
            onClick={createHook}
            disabled={hookBusy || !hookForm.url.trim() || hookForm.events.length === 0}
          >
            {hookBusy ? "saving…" : "Add endpoint"}
          </button>
          <button className="btn ghost" onClick={() => setHookOpen(false)}>Cancel</button>
        </div>
      </Modal>
    </>
  );
}
