/**
 * Affiliate-link-pattern detection in the wild (Section 8.1) — the heart of the
 * headline sourcing feature. Scan outbound links on a page for known affiliate
 * signatures. Anyone with these is a *proven* affiliate; if the link points at a
 * direct competitor, they are the warmest possible target.
 *
 * Pure string/URL analysis: no network, fully testable. The scraper workers feed
 * it discovered links/HTML; this classifies them.
 */

export interface AffiliateNetworkPattern {
  network: string;
  /** Hostnames (suffix match) that belong to this network's redirect/links. */
  hosts?: string[];
  /** Query parameters whose presence signals affiliate tracking. */
  params?: string[];
  /** Path fragments that signal affiliate tracking. */
  pathContains?: string[];
}

export const AFFILIATE_PATTERNS: AffiliateNetworkPattern[] = [
  { network: "Amazon Associates", hosts: ["amzn.to"], params: ["tag"] },
  { network: "Amazon Associates", hosts: ["amazon.com", "amazon.co.uk", "amazon.de"], params: ["tag"] },
  { network: "ShareASale", hosts: ["shareasale.com"], params: ["u", "m", "afftrack"] },
  { network: "Impact", hosts: ["impact.com", "ojrq.net", "7eer.net", "evyy.net"], pathContains: ["/c/"] },
  { network: "Awin", hosts: ["awin1.com", "zenaps.com"], params: ["awinmid", "awinaffid"] },
  { network: "CJ Affiliate", hosts: ["anrdoezrs.net", "dpbolvw.net", "jdoqocy.com", "kqzyfj.com", "tkqlhce.com"] },
  { network: "ClickBank", hosts: ["hop.clickbank.net"] },
  { network: "Rakuten", hosts: ["click.linksynergy.com", "linksynergy.com"], params: ["mid", "murl"] },
  { network: "PartnerStack", hosts: ["partnerstack.com"], pathContains: ["/c/"] },
  { network: "Refersion", hosts: ["refersion.com"], params: ["rfsn"] },
  { network: "FirstPromoter", params: ["fpr", "fp_ref"] },
  { network: "Rewardful", params: ["via"] },
  { network: "Generic affiliate param", params: ["ref", "aff", "affiliate", "aff_id", "referral", "partner"] },
  { network: "Generic affiliate path", pathContains: ["/aff/", "/affiliate/", "/ref/", "/go/", "/recommends/"] },
];

export interface AffiliateSignal {
  url: string;
  network: string;
  /** The matched parameter or path fragment. */
  evidence: string;
  /** The destination host the link points to (for competitor matching). */
  targetHost: string;
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw, raw.startsWith("http") ? undefined : "https://placeholder.invalid");
  } catch {
    return null;
  }
}

function hostMatches(host: string, candidates: string[]): string | null {
  const h = host.toLowerCase();
  for (const c of candidates) {
    if (h === c || h.endsWith(`.${c}`)) return c;
  }
  return null;
}

/** Classify a single URL against the known patterns. Returns all matches. */
export function detectAffiliateUrl(raw: string): AffiliateSignal[] {
  const url = safeUrl(raw);
  if (!url) return [];
  const host = url.hostname.toLowerCase();
  const params = new Set([...url.searchParams.keys()].map((k) => k.toLowerCase()));
  const path = url.pathname.toLowerCase();
  const out: AffiliateSignal[] = [];

  for (const pattern of AFFILIATE_PATTERNS) {
    if (pattern.hosts) {
      const matched = hostMatches(host, pattern.hosts);
      if (matched) {
        // Some host patterns also require a param (e.g. Amazon needs ?tag=).
        if (pattern.params && !pattern.params.some((p) => params.has(p.toLowerCase()))) continue;
        out.push({ url: raw, network: pattern.network, evidence: `host:${matched}`, targetHost: host });
        continue;
      }
    }
    if (pattern.params && !pattern.hosts) {
      const p = pattern.params.find((x) => params.has(x.toLowerCase()));
      if (p) out.push({ url: raw, network: pattern.network, evidence: `param:${p}`, targetHost: host });
    }
    if (pattern.pathContains && !pattern.hosts) {
      const frag = pattern.pathContains.find((f) => path.includes(f));
      if (frag) out.push({ url: raw, network: pattern.network, evidence: `path:${frag}`, targetHost: host });
    }
  }

  return dedupe(out);
}

/** Extract href URLs from raw HTML and classify each. */
export function detectAffiliateLinksInHtml(html: string): AffiliateSignal[] {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
  const signals = hrefs.flatMap((h) => detectAffiliateUrl(h));
  return dedupe(signals);
}

/**
 * Given affiliate signals and a set of competitor domains, return whether the
 * prospect promotes a direct competitor — the strongest scoring signal.
 */
export function promotesCompetitor(signals: AffiliateSignal[], competitorDomains: string[]): boolean {
  const comps = competitorDomains.map((d) => d.toLowerCase().replace(/^www\./, ""));
  return signals.some((s) => {
    const target = s.targetHost.replace(/^www\./, "");
    return comps.some((c) => target === c || target.endsWith(`.${c}`));
  });
}

function dedupe(signals: AffiliateSignal[]): AffiliateSignal[] {
  const seen = new Set<string>();
  const out: AffiliateSignal[] = [];
  for (const s of signals) {
    const key = `${s.url}|${s.network}|${s.evidence}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
