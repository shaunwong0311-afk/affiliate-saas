/**
 * Affiliate-network registry (profile-graph / competitor-affiliate mining). Maps a
 * URL to the network it belongs to and extracts the MERCHANT identity, so we can
 * turn "Acme's competitor" into a precise backlink query ("who links to ShareASale
 * with m=56789" / "who links to acme.pxf.io"). Three shapes:
 *
 *  - vanity:      the brand is a subdomain (Impact `acme.pxf.io`) — query that host.
 *  - shared:      everyone shares a click host; the merchant is a PARAM/path
 *                 (ShareASale `m=`, Awin `awinmid=`) — query the host, filter by id.
 *  - self_hosted: the affiliate link is on the merchant's OWN domain with a marker
 *                 param (Rewardful `?via=`, Refersion `?rfsn=`) — query the apex.
 *
 * Pure (URL/string only). Designed to grow: add a NetworkSpec to extend coverage.
 */

export type NetworkKind = "vanity" | "shared" | "self_hosted";

export interface ResolvedProgram {
  network: string;
  kind: NetworkKind;
  /** Merchant id on a shared network (ShareASale `m`, Awin `awinmid`, …). */
  merchantId: string | null;
  /** Full vanity host on a vanity network (`acme.pxf.io`). */
  vanityHost: string | null;
  /** The merchant's own domain, for self_hosted programs. */
  merchantDomain?: string | null;
}

/** A backlink query: the domain to pull links for, optionally filtered by `url_to` substring. */
export interface BacklinkTarget {
  target: string;
  urlToContains?: string;
}

interface NetworkSpec {
  name: string;
  kind: NetworkKind;
  /** Exact click hosts (shared / clickbank). */
  hosts?: string[];
  /** Vanity host suffixes — the brand is the subdomain. */
  hostSuffixes?: string[];
  /** Param holding the merchant id (shared networks). */
  merchantParam?: string;
  merchantParamAlts?: string[];
  /** Param markers that identify a self_hosted affiliate link on any domain. */
  selfHostedParams?: string[];
  /** Custom extractor for networks whose id lives in the path/subdomain. */
  extract?: (u: URL) => { merchantId?: string | null; vanityHost?: string | null } | null;
}

const NETWORKS: NetworkSpec[] = [
  // ---- Vanity-domain networks (brand = subdomain) ----------------------------
  { name: "Impact", kind: "vanity", hostSuffixes: ["pxf.io", "sjv.io", "7eer.net", "evyy.net", "ojrq.net"] },
  { name: "Partnerize", kind: "vanity", hostSuffixes: ["prf.hn"] },
  { name: "PartnerStack", kind: "vanity", hostSuffixes: ["partnerlinks.io"] },

  // ---- Shared click-host networks (merchant = param / path) ------------------
  { name: "ShareASale", kind: "shared", hosts: ["shareasale.com", "shrsl.com"], merchantParam: "m", merchantParamAlts: ["merchantID"] },
  { name: "Awin", kind: "shared", hosts: ["awin1.com", "zenaps.com"], merchantParam: "awinmid" },
  { name: "Rakuten Advertising", kind: "shared", hosts: ["click.linksynergy.com", "linksynergy.com"], merchantParam: "mid" },
  {
    name: "CJ Affiliate",
    kind: "shared",
    hosts: ["anrdoezrs.net", "dpbolvw.net", "jdoqocy.com", "kqzyfj.com", "tkqlhce.com", "qksrv.net", "emjcd.com", "ftjcfx.com", "lduhtrp.net"],
    merchantParam: "aid",
    extract: (u) => {
      const aid = u.searchParams.get("aid");
      if (aid) return { merchantId: aid };
      const m = u.pathname.match(/\/click-\d+-(\d+)/);
      return m ? { merchantId: m[1]! } : null;
    },
  },
  { name: "Avantlink", kind: "shared", hosts: ["avantlink.com", "track.avantlink.com"], merchantParam: "merchant_id", merchantParamAlts: ["mi"] },
  { name: "Pepperjam", kind: "shared", hosts: ["pntra.com", "pntrac.com", "gopjn.com", "pjtra.com", "pjatr.com"], merchantParam: "programId" },
  { name: "Webgains", kind: "shared", hosts: ["track.webgains.com", "webgains.com"], merchantParam: "wgcampaignid", merchantParamAlts: ["wgprogramid"] },
  {
    name: "ClickBank",
    kind: "shared",
    hosts: ["hop.clickbank.net"],
    merchantParam: "vendor",
    extract: (u) => {
      const sub = u.hostname.toLowerCase().match(/^([a-z0-9-]+)\.hop\.clickbank\.net$/);
      if (sub && sub[1] !== "www") return { merchantId: sub[1]!, vanityHost: u.hostname.toLowerCase().replace(/^www\./, "") };
      const vendor = u.searchParams.get("vendor");
      return vendor ? { merchantId: vendor } : null;
    },
  },

  // ---- Self-hosted (affiliate link on the merchant's own domain) -------------
  { name: "Rewardful", kind: "self_hosted", selfHostedParams: ["via"] },
  { name: "Refersion", kind: "self_hosted", selfHostedParams: ["rfsn"] },
  { name: "FirstPromoter", kind: "self_hosted", selfHostedParams: ["fpr", "fp_ref"] },
  { name: "PartnerStack (self-serve)", kind: "self_hosted", selfHostedParams: ["ps_partner_key", "gr_pk"] },
];

function hostOf(u: URL): string {
  return u.hostname.replace(/^www\./, "").toLowerCase();
}

function parseUrl(raw: string): URL | null {
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Identify the affiliate network + merchant from a URL (an affiliate link or join link). */
export function identifyProgram(rawUrl: string): ResolvedProgram | null {
  const u = parseUrl(rawUrl);
  if (!u) return null;
  const host = hostOf(u);

  for (const spec of NETWORKS) {
    if (spec.hostSuffixes?.some((s) => host === s || host.endsWith(`.${s}`))) {
      const ex = spec.extract?.(u);
      return { network: spec.name, kind: "vanity", merchantId: ex?.merchantId ?? null, vanityHost: ex?.vanityHost ?? host };
    }
    if (spec.hosts?.some((h) => host === h || host.endsWith(`.${h}`))) {
      const ex = spec.extract ? spec.extract(u) : null;
      const merchantId =
        ex?.merchantId ??
        (spec.merchantParam ? u.searchParams.get(spec.merchantParam) : null) ??
        firstParam(u, spec.merchantParamAlts);
      return { network: spec.name, kind: spec.kind, merchantId: merchantId ?? null, vanityHost: ex?.vanityHost ?? null };
    }
  }
  // self_hosted: any host carrying a known marker param.
  for (const spec of NETWORKS) {
    if (spec.kind === "self_hosted" && spec.selfHostedParams?.some((p) => u.searchParams.has(p))) {
      return { network: spec.name, kind: "self_hosted", merchantId: null, vanityHost: null, merchantDomain: host };
    }
  }
  return null;
}

function firstParam(u: URL, params?: string[]): string | null {
  for (const p of params ?? []) {
    const v = u.searchParams.get(p);
    if (v) return v;
  }
  return null;
}

/** The backlink queries that surface a program's affiliates. */
export function backlinkTargetsFor(program: ResolvedProgram, competitorDomain?: string): BacklinkTarget[] {
  if (program.vanityHost) return [{ target: program.vanityHost }]; // vanity / clickbank subdomain
  const spec = NETWORKS.find((s) => s.name === program.network);
  if (program.kind === "shared" && program.merchantId && spec?.hosts) {
    const param = spec.merchantParam ?? "m";
    return spec.hosts.map((h) => ({ target: h, urlToContains: `${param}=${program.merchantId}` }));
  }
  if (program.kind === "self_hosted") {
    const dom = competitorDomain ?? program.merchantDomain ?? null;
    const param = spec?.selfHostedParams?.[0];
    return dom ? [{ target: dom, urlToContains: param ? `${param}=` : undefined }] : [];
  }
  return [];
}

/**
 * Parse a MANUAL override into a program. Forgiving: accepts a pasted affiliate /
 * join link (best — we extract it), a "Network id" pair ("ShareASale 56789",
 * "awin:12345"), or a bare vanity domain ("acme.pxf.io").
 */
export function parseProgramInput(text: string, competitorDomain?: string): ResolvedProgram | null {
  const t = text.trim();
  if (!t) return null;

  // 1) A pasted URL / domain → extract directly.
  if (/^https?:\/\//i.test(t) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(t)) {
    const byUrl = identifyProgram(t);
    if (byUrl) return byUrl;
  }

  // 2) "Network id" / "network:id".
  const m = t.match(/^(.+?)[\s:]+([\w.-]+)$/);
  if (m) {
    const netName = m[1]!.trim().toLowerCase().replace(/[^a-z]/g, "");
    const id = m[2]!.trim();
    const spec = NETWORKS.find((s) => {
      const key = s.name.toLowerCase().replace(/[^a-z]/g, "");
      return key.startsWith(netName) || netName.startsWith(key.split(" ")[0]!);
    });
    if (spec) {
      if (spec.kind === "vanity") return { network: spec.name, kind: "vanity", merchantId: null, vanityHost: id.includes(".") ? id.toLowerCase() : null };
      if (spec.kind === "self_hosted") return { network: spec.name, kind: "self_hosted", merchantId: null, vanityHost: null, merchantDomain: competitorDomain ?? id };
      return { network: spec.name, kind: "shared", merchantId: id, vanityHost: null };
    }
  }
  return null;
}

/** The networks we recognize, for UI hints / docs. */
export function knownNetworks(): { name: string; kind: NetworkKind }[] {
  return NETWORKS.map((s) => ({ name: s.name, kind: s.kind }));
}
