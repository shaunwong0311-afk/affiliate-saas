import { useState } from "react";
import { api } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState } from "../ui";

interface TrackingLink {
  offerId: string;
  offerName: string;
  code: string;
  url: string;
}

export function PortalLinks() {
  const { data, loading, error } = useApi<TrackingLink[]>(() => api.get("/portal/links"));
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(link: TrackingLink) {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(link.offerId);
      window.setTimeout(() => setCopied((c) => (c === link.offerId ? null : c)), 1800);
    } catch {
      setCopied(null);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;

  const links = data ?? [];

  return (
    <>
      <PageHeader
        title="Your links"
        crumb="PORTAL"
        subtitle="Deep-link to any product page on the store — append your tracking code to any URL and every click, on any device, is attributed to you. Where a raw link can't follow the buyer, your code still captures the credit."
      />

      {links.length === 0 ? (
        <EmptyState
          title="No tracking links yet"
          hint="Once you're approved onto an offer, your unique deep-link and code appear here. Until then, there's nothing to share."
        />
      ) : (
        <Card flush title={`Tracking links · ${links.length}`} sub="one per active offer — share the URL, fall back to the code">
          <table className="table">
            <thead>
              <tr>
                <th>Offer</th>
                <th>Tracking URL</th>
                <th>Code</th>
                <th className="num">Action</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.offerId}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{link.offerName}</div>
                    <div className="faint mono" style={{ fontSize: 11 }}>{link.offerId}</div>
                  </td>
                  <td>
                    <code
                      className="mono"
                      style={{
                        display: "block",
                        maxWidth: 420,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        background: "var(--ink-850)",
                        border: "1px solid var(--line)",
                        borderRadius: 6,
                        padding: "6px 9px",
                        fontSize: 12,
                      }}
                      title={link.url}
                    >
                      {link.url}
                    </code>
                  </td>
                  <td>
                    <Badge kind="info">{link.code}</Badge>
                  </td>
                  <td className="num">
                    <button className="btn sm" onClick={() => copy(link)}>
                      {copied === link.offerId ? "✓ copied" : "Copy"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <div className="mt-24">
        <Card title="Codes capture what links can't" sub="attribution survives the gaps a URL leaves behind">
          <div className="grid grid-3 mt-16">
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Cross-device</strong>
              <p style={{ marginTop: 4 }}>Someone clicks on mobile but buys on desktop hours later. The cookie is gone — your code, typed at checkout, still earns you the commission.</p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Offline</strong>
              <p style={{ marginTop: 4 }}>Podcasts, packaging inserts, events, print. There's no link to click — read out the code and credit follows the buyer wherever they convert.</p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Link-hostile</strong>
              <p style={{ marginTop: 4 }}>Bios, DMs, and platforms that strip or block tracking parameters. The code rides along in plain text and lands the attribution anyway.</p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
