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

import { hostIsOrUnder, isSharedPlatformHost } from "./hosts.js";

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
  /**
   * TRUE when a self_hosted program was recognized only by a GENERIC marker param
   * (Rewardful's `?via=`, which is also Twitter's "via @user" share param and a common
   * plain tracking tag). Good enough to read a competitor's OWN program page, where the
   * host is already known to be the merchant — never enough, on an arbitrary host found
   * in the wild, to call that host a merchant.
   */
  genericMarker?: boolean;
}

/** A backlink query: the domain to pull links for, optionally filtered by `url_to` substring. */
export interface BacklinkTarget {
  target: string;
  urlToContains?: string;
  /**
   * For shared-network merchant-id queries: the exact param + value the destination
   * must carry. The provider-side `urlToContains` filter is a substring LIKE
   * (`%m=1234%` also matches `m=12345`), so callers MUST re-verify rows against
   * these before trusting them as the merchant's affiliates.
   */
  param?: string;
  value?: string;
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
  /** The marker param is a common word, not a network-specific name (see `genericMarker`). */
  genericMarker?: boolean;
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
    // UNVALIDATED against live CJ links (AUDIT-2026-10 D16). Two assumptions here are
    // most likely wrong on a first real run:
    //  1. In the legacy path form `/click-<PID>-<AID>` the second number is CJ's LINK
    //     ("ad") id — one advertiser has many — not a stable advertiser/merchant id.
    //  2. `backlinkTargetsFor` turns this into a query filter `aid=<id>` plus an exact
    //     `?aid=` param check, which a path-style link can never satisfy, so path-style
    //     rows are dropped by BacklinkDiscoverySource rather than mis-attributed.
    // Net effect today: CJ programs resolve, but mining them returns nothing. That is
    // an honest empty, not a wrong answer; fix only with real CJ rows in hand.
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
  { name: "Rewardful", kind: "self_hosted", selfHostedParams: ["via"], genericMarker: true },
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
  // self_hosted: any host carrying a known marker param. Network-specific markers
  // (`rfsn`, `fpr`, …) are tried before the generic one (`via`), so a link carrying both
  // is identified by the stronger evidence.
  const selfHosted = NETWORKS.filter((s) => s.kind === "self_hosted");
  for (const spec of [...selfHosted.filter((s) => !s.genericMarker), ...selfHosted.filter((s) => s.genericMarker)]) {
    if (spec.selfHostedParams?.some((p) => u.searchParams.has(p))) {
      return {
        network: spec.name,
        kind: "self_hosted",
        merchantId: null,
        vanityHost: null,
        merchantDomain: host,
        ...(spec.genericMarker ? { genericMarker: true } : {}),
      };
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
    // param/value carry the EXACT merchant id so the caller can post-filter the
    // provider's substring LIKE (which would also match longer ids).
    return spec.hosts.map((h) => ({ target: h, urlToContains: `${param}=${program.merchantId}`, param, value: program.merchantId! }));
  }
  if (program.kind === "self_hosted") {
    const dom = competitorDomain ?? program.merchantDomain ?? null;
    const param = spec?.selfHostedParams?.[0];
    return dom ? [{ target: dom, urlToContains: param ? `${param}=` : undefined }] : [];
  }
  return [];
}

// Only SHARED click hosts (shareasale.com, awin1.com…) — NOT vanity suffixes, since a
// vanity host (acme.pxf.io) IS the brand and is itself a mineable merchant.
function isNetworkClickHost(host: string): boolean {
  return NETWORKS.some((s) => (s.hosts ?? []).some((h) => host === h || host.endsWith(`.${h}`)));
}

/**
 * From the affiliate links found on a creator's page, the OTHER merchant hosts they
 * promote — the recursive-discovery expansion signal, i.e. what the frontier will
 * spend backlink budget mining next. A host qualifies ONLY when the network registry
 * identifies it (see {@link merchantDomainFromLink}); generic `?ref=` / `?via=` /
 * `/go/` shapes never do, because nearly every share button, shortener and product
 * link on the web carries one. Network click hosts, shared platforms (social,
 * marketplaces, shorteners, search) and `exclude`d hosts — your own domains and known
 * competitors, including their subdomains — are filtered out.
 */
export function competitorHostsFromLinks(links: string[], exclude: Iterable<string> = []): string[] {
  const skip = [...exclude].map((d) => d.toLowerCase().replace(/^www\./, "")).filter(Boolean);
  const out = new Set<string>();
  for (const raw of links) {
    const found = merchantDomainFromLink(raw);
    if (!found) continue;
    const merchant = found.toLowerCase().replace(/^www\./, "");
    if (skip.some((s) => hostIsOrUnder(merchant, s))) continue;
    if (isNetworkClickHost(merchant) || isSharedPlatformHost(merchant)) continue;
    out.add(merchant);
  }
  return [...out];
}

/**
 * The merchant brand DOMAIN an affiliate link provably points at, per the network
 * registry:
 *  - a vanity host — `acme.pxf.io` IS the brand's tracking domain;
 *  - a SHARED-network link whose destination is spelled out in its params
 *    (`shareasale.com/…&urllink=https://brand.com`, Rakuten `murl`, Awin `ued`);
 *  - a self-hosted program link carrying a NETWORK-SPECIFIC marker (`?rfsn=`, `?fpr=`,
 *    `?ps_partner_key=`) — the host is the merchant's own.
 * Returns null for everything else, on purpose: a generic `?ref=`, `?aff=`, `?via=` or
 * `/go/` path is a LOW-confidence shape (see affiliate-detection.ts) that says nothing
 * reliable about who the host is — `twitter.com/intent/tweet?via=…` and
 * `bluehost.com/go/…` both match. A shared-network link with no recoverable destination
 * also returns null (it would need its redirect followed).
 */
export function merchantDomainFromLink(rawUrl: string): string | null {
  const u = parseUrl(rawUrl);
  if (!u) return null;
  const prog = identifyProgram(rawUrl);
  if (!prog) return null;
  if (prog.kind === "vanity") return prog.vanityHost ?? null;
  if (prog.kind === "shared") return destinationHostFromParams(u); // resolve via the dest param
  if (prog.kind === "self_hosted" && !prog.genericMarker) return prog.merchantDomain ?? null;
  return null;
}

// Network deep-links carry the destination URL in a param (urllink/murl/ued/url/…).
// Scan for any param whose value is an http(s) URL to a non-network host.
function destinationHostFromParams(u: URL): string | null {
  for (const v of u.searchParams.values()) {
    if (v.length < 10) continue;
    let decoded = v;
    try {
      decoded = decodeURIComponent(v);
    } catch {
      /* keep raw */
    }
    if (!/^https?:\/\//i.test(decoded)) continue;
    try {
      const h = new URL(decoded).hostname.replace(/^www\./, "").toLowerCase();
      if (h && !isNetworkClickHost(h)) return h;
    } catch {
      /* not a usable URL */
    }
  }
  return null;
}
