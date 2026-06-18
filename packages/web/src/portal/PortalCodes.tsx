import { useState } from "react";
import { api, pct, num, shortDate } from "../api";
import { useApi, Card, Spinner, ErrorBanner, PageHeader, Badge, EmptyState } from "../ui";

interface AffiliateCode {
  code: string;
  kind: "discount" | "referral" | string;
  discountValue: number | null;
  usageCap: number | null;
  usageCount: number;
  expiresAt: string | null;
}

function isExpired(iso: string | null): boolean {
  return !!iso && new Date(iso).getTime() < Date.now();
}

export function PortalCodes() {
  const { data, loading, error } = useApi<AffiliateCode[]>(() => api.get("/portal/codes"));
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      window.setTimeout(() => setCopied((c) => (c === code ? null : c)), 1800);
    } catch {
      setCopied(null);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;

  const codes = data ?? [];
  const totalRedemptions = codes.reduce((sum, c) => sum + c.usageCount, 0);

  return (
    <>
      <PageHeader
        title="Your codes"
        crumb="PORTAL"
        subtitle="Personal discount and referral codes you can read out anywhere — video, audio, packaging, IRL. No link to click; the code carries the attribution and lands you the commission wherever the buyer converts."
      />

      {codes.length === 0 ? (
        <EmptyState
          title="No codes yet"
          hint="Once a merchant issues you a discount or referral code, it appears here with its discount, usage, and expiry. Until then, share your tracking links."
        />
      ) : (
        <Card
          flush
          title={`Your codes · ${codes.length}`}
          sub={`${num(totalRedemptions)} total redemptions — copy the code and share it anywhere`}
        >
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Type</th>
                <th className="num">Discount</th>
                <th className="num">Usage</th>
                <th>Expires</th>
                <th className="num">Action</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => {
                const expired = isExpired(c.expiresAt);
                return (
                  <tr key={c.code}>
                    <td>
                      <code
                        className="mono"
                        style={{
                          display: "inline-block",
                          background: "var(--ink-850)",
                          border: "1px solid var(--line)",
                          borderRadius: 6,
                          padding: "5px 9px",
                          fontSize: 13,
                          fontWeight: 600,
                          letterSpacing: 0.5,
                        }}
                        title={c.code}
                      >
                        {c.code}
                      </code>
                    </td>
                    <td>
                      <Badge kind={c.kind === "discount" ? "info" : "tier-A"}>{c.kind}</Badge>
                    </td>
                    <td className="num mono">
                      {c.discountValue != null ? pct(c.discountValue) : <span className="faint">—</span>}
                    </td>
                    <td className="num mono">
                      {num(c.usageCount)}
                      <span className="faint"> / {c.usageCap != null ? num(c.usageCap) : "∞"}</span>
                    </td>
                    <td>
                      {c.expiresAt ? (
                        expired ? (
                          <Badge kind="neg">expired</Badge>
                        ) : (
                          <span className="muted" style={{ fontSize: 12.5 }}>{shortDate(c.expiresAt)}</span>
                        )
                      ) : (
                        <span className="faint">never</span>
                      )}
                    </td>
                    <td className="num">
                      <button className="btn sm" onClick={() => copy(c.code)} disabled={expired}>
                        {copied === c.code ? "✓ copied" : "Copy"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <div className="mt-24">
        <Card title="When codes beat links" sub="attribution that survives where a URL can't follow">
          <div className="grid grid-3 mt-16">
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Discount codes</strong>
              <p style={{ marginTop: 4 }}>Give your audience a real reason to buy. The saving at checkout is the hook; the attribution to you is automatic.</p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Referral codes</strong>
              <p style={{ marginTop: 4 }}>No discount needed — the code exists purely to credit you. Perfect for partners whose audience already intends to buy.</p>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              <strong className="acc">Offline &amp; spoken</strong>
              <p style={{ marginTop: 4 }}>Podcasts, packaging, events, print. Read out the code, and credit follows the buyer to whatever device they convert on.</p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
