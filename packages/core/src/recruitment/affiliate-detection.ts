/**
 * Affiliate-link-pattern detection in the wild (Section 8.1) — the heart of the
 * headline sourcing feature. Scan outbound links on a page for known affiliate
 * signatures. Anyone with these is a *proven* affiliate; if the link points at a
 * direct competitor, they are the warmest possible target.
 *
 * Pure string/URL analysis: no network, fully testable. The scraper workers feed
 * it discovered links/HTML; this classifies them.
 */

/**
 * Confidence in a match:
 *  - `high`  — a named affiliate-network signature (Amazon `?tag=`, ShareASale,
 *    Impact, etc.). Strong evidence on its own.
 *  - `low`   — a GENERIC pattern (`?ref=`, `?via=`, `/go/`, …) that often, but not
 *    always, indicates an affiliate link. These MUST be resolved/verified (follow
 *    the redirect) before being treated as competitor-promotion evidence, or they
 *    produce false positives.
 */
export type SignalConfidence = "high" | "low";

export interface AffiliateNetworkPattern {
  network: string;
  confidence: SignalConfidence;
  /** Hostnames (suffix match) that belong to this network's redirect/links. */
  hosts?: string[];
  /**
   * Query parameters whose presence signals affiliate tracking. On a HOST pattern they
   * are a REQUIREMENT: the host matches only when one of `params` or `pathContains` is
   * present (a network's marketing site is not an affiliate link).
   */
  params?: string[];
  /** Path fragments that signal affiliate tracking (a requirement on a host pattern, as above). */
  pathContains?: string[];
  /**
   * The host is a tracking-only domain whose BRAND is the subdomain (`acme.pxf.io`): the
   * bare apex is not a link, any subdomain is.
   */
  subdomainOnly?: boolean;
}

export const AFFILIATE_PATTERNS: AffiliateNetworkPattern[] = [
  // amzn.to is Amazon's affiliate shortener by definition — real SiteStripe short
  // links carry NO query params, so the host alone is a HIGH-confidence match.
  // Full amazon.* domains still require ?tag= (a plain product link isn't a signal).
  { network: "Amazon Associates", confidence: "high", hosts: ["amzn.to"] },
  { network: "Amazon Associates", confidence: "high", hosts: ["amazon.com", "amazon.co.uk", "amazon.de"], params: ["tag"] },
  { network: "ShareASale", confidence: "high", hosts: ["shareasale.com"], params: ["u", "m", "afftrack"] },
  // shrsl.com is ShareASale's short-link domain — like amzn.to, the host alone is the signal.
  { network: "ShareASale", confidence: "high", hosts: ["shrsl.com"] },
  // Impact's brand tracking domains host nothing but tracking links (both the long
  // `/c/<partner>/<ad>/<campaign>` form and short vanity links), so any brand subdomain
  // counts. impact.com itself is the company's marketing site: only a `/c/` path is a link.
  { network: "Impact", confidence: "high", hosts: ["pxf.io", "sjv.io", "ojrq.net", "7eer.net", "evyy.net"], subdomainOnly: true },
  { network: "Impact", confidence: "high", hosts: ["impact.com"], pathContains: ["/c/"] },
  { network: "Awin", confidence: "high", hosts: ["awin1.com", "zenaps.com"], params: ["awinmid", "awinaffid"] },
  { network: "CJ Affiliate", confidence: "high", hosts: ["anrdoezrs.net", "dpbolvw.net", "jdoqocy.com", "kqzyfj.com", "tkqlhce.com"] },
  { network: "ClickBank", confidence: "high", hosts: ["hop.clickbank.net"] },
  { network: "Rakuten", confidence: "high", hosts: ["click.linksynergy.com", "linksynergy.com"], params: ["mid", "murl"] },
  // Partnerize's click domain (`prf.hn/click/camref:…`) — tracking only.
  { network: "Partnerize", confidence: "high", hosts: ["prf.hn"] },
  { network: "PartnerStack", confidence: "high", hosts: ["partnerstack.com"], pathContains: ["/c/"] },
  { network: "PartnerStack", confidence: "high", hosts: ["partnerlinks.io"], subdomainOnly: true },
  { network: "Refersion", confidence: "high", hosts: ["refersion.com"], params: ["rfsn"] },
  { network: "FirstPromoter", confidence: "high", params: ["fpr", "fp_ref"] },
  { network: "Rewardful", confidence: "low", params: ["via"] },
  { network: "Generic affiliate param", confidence: "low", params: ["ref", "aff", "affiliate", "aff_id", "referral", "partner"] },
  { network: "Generic affiliate path", confidence: "low", pathContains: ["/aff/", "/affiliate/", "/ref/", "/go/", "/recommends/"] },
];

export interface AffiliateSignal {
  url: string;
  network: string;
  confidence: SignalConfidence;
  /** The matched parameter or path fragment. */
  evidence: string;
  /** The destination host the link points to (for competitor matching). */
  targetHost: string;
  /** Set by the redirect resolver once the final destination has been confirmed. */
  verified?: boolean;
  /** The resolved final host (after following redirects), if verified. */
  resolvedHost?: string;
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
        if (pattern.subdomainOnly && host === matched) continue; // the bare tracking apex is not a link
        // A host pattern that names params and/or path fragments REQUIRES one of them
        // (Amazon needs ?tag=, impact.com needs /c/) — otherwise every link to a network's
        // own marketing site would read as a proven affiliate link.
        const hasParam = pattern.params?.some((p) => params.has(p.toLowerCase())) ?? false;
        const hasPath = pattern.pathContains?.some((f) => path.includes(f)) ?? false;
        if ((pattern.params || pattern.pathContains) && !hasParam && !hasPath) continue;
        out.push({ url: raw, network: pattern.network, confidence: pattern.confidence, evidence: `host:${matched}`, targetHost: host });
        continue;
      }
    }
    if (pattern.params && !pattern.hosts) {
      const p = pattern.params.find((x) => params.has(x.toLowerCase()));
      if (p) out.push({ url: raw, network: pattern.network, confidence: pattern.confidence, evidence: `param:${p}`, targetHost: host });
    }
    if (pattern.pathContains && !pattern.hosts) {
      const frag = pattern.pathContains.find((f) => path.includes(f));
      if (frag) out.push({ url: raw, network: pattern.network, confidence: pattern.confidence, evidence: `path:${frag}`, targetHost: host });
    }
  }

  return dedupe(out);
}

/** True only if at least one HIGH-confidence (named-network) signal is present. */
export function hasProvenAffiliateSignal(signals: AffiliateSignal[]): boolean {
  return signals.some((s) => s.confidence === "high");
}

/**
 * Extract href URLs from raw HTML and classify each. Pass the page's own URL as
 * `baseUrl` so relative links (`/go/brand` — the usual shape of a cloaked affiliate
 * link) come back ABSOLUTE and can be followed; without it they are classified as
 * found and cannot be resolved.
 */
export function detectAffiliateLinksInHtml(html: string, baseUrl?: string | null): AffiliateSignal[] {
  const base = baseUrl ? safeUrl(baseUrl) : null;
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => absolutize(m[1]!, base));
  const signals = hrefs.flatMap((h) => (h ? detectAffiliateUrl(h) : []));
  return dedupe(signals);
}

function absolutize(href: string, base: URL | null): string | null {
  if (/^(mailto:|tel:|javascript:|data:|#)/i.test(href)) return null;
  if (!base || /^https?:\/\//i.test(href)) return href;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether the prospect promotes a direct competitor — the strongest scoring
 * signal. The test is destination CERTAINTY, not pattern confidence: a link counts
 * only when we actually know it lands on the competitor.
 *
 *  - The link points DIRECTLY at the competitor's domain (`competitor.com/x?ref=`):
 *    the destination is not in doubt, so it counts.
 *  - The link goes through a THIRD-PARTY redirector (`bit.ly/x`, a network domain):
 *    the destination is unknown until a redirect resolver follows it. It counts
 *    only once `resolvedHost` confirms the competitor — never on assumption.
 *
 * This is the fix for the generic `?ref=`/`?via=` false positive: we never assume a
 * redirector lands on the competitor; we either see the competitor in the URL or we
 * resolve it.
 */
export function promotesCompetitor(signals: AffiliateSignal[], competitorDomains: string[]): boolean {
  const comps = competitorDomains.map((d) => d.toLowerCase().replace(/^www\./, ""));
  const hostHits = (host: string | undefined): boolean => {
    if (!host) return false;
    const target = host.toLowerCase().replace(/^www\./, "");
    return comps.some((c) => target === c || target.endsWith(`.${c}`));
  };
  return signals.some((s) => hostHits(s.targetHost) || hostHits(s.resolvedHost));
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
