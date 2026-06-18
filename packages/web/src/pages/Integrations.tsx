import { useState } from "react";
import { api, shortDate } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState, Field, statusKind } from "../ui";

interface Integration {
  id: string;
  kind: string;
  status: string;
  lastSyncAt: string | null;
}

interface Mailbox {
  id: string;
  provider: string;
  email: string;
  status: string;
  dailyCap: number;
  warmupStatus: string;
}

interface Domain {
  id: string;
  domain: string;
  spfStatus: string;
  dkimStatus: string;
  dmarcStatus: string;
  warmupStatus: string;
}

const STORE_KINDS = [
  { value: "shopify", label: "Shopify" },
  { value: "woocommerce", label: "WooCommerce" },
  { value: "stripe", label: "Stripe" },
  { value: "s2s", label: "Server-to-server (S2S)" },
];

const MAILBOX_PROVIDERS = [
  { value: "gmail", label: "Gmail / Google Workspace" },
  { value: "microsoft", label: "Microsoft 365" },
  { value: "smtp", label: "Custom SMTP" },
];

export function Integrations() {
  const integrations = useApi<Integration[]>(() => api.get("/integrations"));
  const mailboxes = useApi<Mailbox[]>(() => api.get("/mailboxes"));
  const domains = useApi<Domain[]>(() => api.get("/sending-domains"));

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // store/payment connect form
  const [storeKind, setStoreKind] = useState("shopify");

  // mailbox connect form
  const [mbProvider, setMbProvider] = useState("gmail");
  const [mbEmail, setMbEmail] = useState("");
  const [mbCap, setMbCap] = useState(50);

  // domain form
  const [domainName, setDomainName] = useState("");

  async function run(key: string, fn: () => Promise<unknown>, reload: () => void) {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e: any) {
      setErr(e?.message ?? "request failed");
    } finally {
      setBusy(null);
    }
  }

  async function connectStore() {
    await run("store", () => api.post("/integrations", { kind: storeKind, config: {}, credentialsRef: "" }), integrations.reload);
  }

  async function connectMailbox() {
    if (!mbEmail.trim()) {
      setErr("Mailbox email is required.");
      return;
    }
    await run("mailbox", async () => {
      await api.post("/mailboxes", { provider: mbProvider, email: mbEmail.trim(), dailyCap: mbCap });
      setMbEmail("");
      setMbCap(50);
    }, mailboxes.reload);
  }

  async function addDomain() {
    const d = domainName.trim().toLowerCase();
    if (!d) {
      setErr("Domain is required.");
      return;
    }
    await run("domain", async () => {
      await api.post("/sending-domains", { domain: d });
      setDomainName("");
    }, domains.reload);
  }

  if (integrations.loading || mailboxes.loading || domains.loading) return <Spinner />;
  if (integrations.error) return <ErrorBanner message={integrations.error} />;
  if (mailboxes.error) return <ErrorBanner message={mailboxes.error} />;
  if (domains.error) return <ErrorBanner message={domains.error} />;

  const stores = integrations.data ?? [];
  const boxes = mailboxes.data ?? [];
  const doms = domains.data ?? [];

  return (
    <>
      <PageHeader
        title="Integrations"
        crumb="INFRASTRUCTURE"
        subtitle="Wire up the store and payment rails that feed conversions, and the sending infrastructure — mailboxes and authenticated domains — that the recruitment engine sends through. Good deliverability is the difference between outreach that lands and outreach that bounces."
      />

      {err && <ErrorBanner message={err} />}

      {/* Stores & payments */}
      <Card
        flush
        title="Stores & payments"
        sub="connect the source of truth for orders, refunds, and conversion events"
        actions={
          <div className="row gap-8">
            <select className="select" value={storeKind} onChange={(e) => setStoreKind(e.target.value)} style={{ minWidth: 200 }}>
              {STORE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </select>
            <button className="btn primary sm" onClick={connectStore} disabled={busy === "store"}>
              {busy === "store" ? "connecting…" : "Connect"}
            </button>
          </div>
        }
      >
        {stores.length === 0 ? (
          <div style={{ padding: "0 20px 18px" }}>
            <EmptyState
              title="No stores connected"
              hint="Connect Shopify, WooCommerce, Stripe, or a server-to-server feed so conversions are tracked at the source."
            />
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Status</th>
                <th>Last sync</th>
                <th className="num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div style={{ fontWeight: 600, textTransform: "capitalize" }}>{s.kind}</div>
                    <div className="faint mono" style={{ fontSize: 11 }}>{s.id}</div>
                  </td>
                  <td><Badge kind={statusKind(s.status)}>{s.status}</Badge></td>
                  <td className="muted" style={{ fontSize: 12 }}>{shortDate(s.lastSyncAt)}</td>
                  <td className="num">
                    <button
                      className="btn danger sm"
                      onClick={() => run(`store-del-${s.id}`, () => api.del(`/integrations/${s.id}`), integrations.reload)}
                      disabled={busy === `store-del-${s.id}`}
                    >
                      Disconnect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Mailboxes */}
      <div className="mt-24">
        <Card flush title="Mailboxes" sub="we send as the merchant — outreach lands from your own inbox, not a shared relay">
          <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
            <div className="grid grid-4" style={{ alignItems: "end" }}>
              <Field label="Provider">
                <select className="select" value={mbProvider} onChange={(e) => setMbProvider(e.target.value)}>
                  {MAILBOX_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Inbox address">
                <input
                  className="input"
                  type="email"
                  placeholder="founder@yourbrand.com"
                  value={mbEmail}
                  onChange={(e) => setMbEmail(e.target.value)}
                />
              </Field>
              <Field label="Daily send cap">
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={mbCap}
                  onChange={(e) => setMbCap(Math.max(1, Number(e.target.value) || 1))}
                />
              </Field>
              <button className="btn primary" onClick={connectMailbox} disabled={busy === "mailbox"}>
                {busy === "mailbox" ? "connecting…" : "Connect mailbox"}
              </button>
            </div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>
              Outreach sends as the merchant. Keep caps low while warming up to protect deliverability.
            </div>
          </div>

          {boxes.length === 0 ? (
            <div style={{ padding: "0 20px 18px" }}>
              <EmptyState title="No mailboxes connected" hint="Connect Gmail, Microsoft 365, or SMTP to start sending recruitment outreach." />
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Mailbox</th>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Warmup</th>
                  <th className="num">Daily cap</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {boxes.map((b) => (
                  <tr key={b.id}>
                    <td><span className="mono" style={{ fontSize: 12.5 }}>{b.email}</span></td>
                    <td className="muted" style={{ fontSize: 12, textTransform: "capitalize" }}>{b.provider}</td>
                    <td><Badge kind={statusKind(b.status)}>{b.status}</Badge></td>
                    <td><Badge kind={statusKind(b.warmupStatus)}>{b.warmupStatus}</Badge></td>
                    <td className="num mono">{b.dailyCap}</td>
                    <td className="num">
                      <div className="row gap-8" style={{ justifyContent: "flex-end" }}>
                        {b.warmupStatus === "warming" ? (
                          <button
                            className="btn sm ghost"
                            onClick={() => run(`mb-warm-${b.id}`, () => api.patch(`/mailboxes/${b.id}`, { warmupStatus: "active" }), mailboxes.reload)}
                            disabled={busy === `mb-warm-${b.id}`}
                          >
                            Mark warmed
                          </button>
                        ) : (
                          <button
                            className="btn sm ghost"
                            onClick={() => run(`mb-warm-${b.id}`, () => api.patch(`/mailboxes/${b.id}`, { warmupStatus: "warming" }), mailboxes.reload)}
                            disabled={busy === `mb-warm-${b.id}`}
                          >
                            Restart warmup
                          </button>
                        )}
                        <button
                          className="btn danger sm"
                          onClick={() => run(`mb-del-${b.id}`, () => api.del(`/mailboxes/${b.id}`), mailboxes.reload)}
                          disabled={busy === `mb-del-${b.id}`}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* Sending domains */}
      <div className="mt-24">
        <Card
          flush
          title="Sending domains"
          sub="authenticate SPF, DKIM, and DMARC so mailbox sends are trusted by inbox providers"
          actions={
            <div className="row gap-8">
              <input
                className="input"
                placeholder="mail.yourbrand.com"
                value={domainName}
                onChange={(e) => setDomainName(e.target.value)}
                style={{ minWidth: 220 }}
              />
              <button className="btn primary sm" onClick={addDomain} disabled={busy === "domain"}>
                {busy === "domain" ? "adding…" : "Add domain"}
              </button>
            </div>
          }
        >
          {doms.length === 0 ? (
            <div style={{ padding: "0 20px 18px" }}>
              <EmptyState
                title="No sending domains"
                hint="Add a subdomain you own, publish the DNS records, then verify to authenticate SPF, DKIM, and DMARC."
              />
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>SPF</th>
                  <th>DKIM</th>
                  <th>DMARC</th>
                  <th>Warmup</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {doms.map((d) => (
                  <tr key={d.id}>
                    <td><span className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{d.domain}</span></td>
                    <td><Badge kind={statusKind(d.spfStatus)}>{d.spfStatus}</Badge></td>
                    <td><Badge kind={statusKind(d.dkimStatus)}>{d.dkimStatus}</Badge></td>
                    <td><Badge kind={statusKind(d.dmarcStatus)}>{d.dmarcStatus}</Badge></td>
                    <td><Badge kind={statusKind(d.warmupStatus)}>{d.warmupStatus}</Badge></td>
                    <td className="num">
                      <button
                        className="btn sm"
                        onClick={() => run(`dom-verify-${d.id}`, () => api.post(`/sending-domains/${d.id}/verify`, {}), domains.reload)}
                        disabled={busy === `dom-verify-${d.id}`}
                      >
                        {busy === `dom-verify-${d.id}` ? "verifying…" : "Verify"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
