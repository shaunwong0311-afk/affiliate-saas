import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { networkInterfaces } from "node:os";
import * as zlib from "node:zlib";

/**
 * Outbound fetch safety — the ONE place a URL that came from outside the codebase is
 * allowed to turn into a request (AUDIT-2026-10 contract 5). "Outside" means a page we
 * scraped, a SERP result, an import row, a podcast feed, a tenant's webhook target:
 * anything an attacker can choose. Without this, such a URL can point the server at
 * itself or its neighbours — `http://169.254.169.254/` (cloud credentials),
 * `http://localhost:5432/`, `http://10.0.0.5/admin` — directly or after a redirect.
 *
 * {@link guardedFetch} therefore:
 *  1. screens the URL itself (http/https only, no embedded credentials, no internal names);
 *  2. RESOLVES the host and requires every address to be public — so a public-looking
 *     name that points at 127.0.0.1 is caught, and so are decimal/hex/IPv6-mapped
 *     spellings of a private address;
 *  3. connects to exactly the address it checked (the default transport pins the
 *     lookup), closing the gap between "checked" and "connected" (DNS rebinding);
 *  4. follows redirects ITSELF, repeating 1–3 on every hop;
 *  5. enforces one deadline for the whole exchange and a cap on the body it will read.
 *
 * It does not decide WHO may be fetched (robots, rate limits, proxies) — only that the
 * target is a public internet host. Proxying plugs in as a {@link GuardedTransport}.
 */

/** Thrown when a URL (or a redirect hop) is refused. Carries the reason, never retried. */
export class UnsafeUrlError extends Error {
  readonly code = "unsafe_url";
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`blocked outbound request to ${redactUrl(url)}: ${reason}`);
    this.name = "UnsafeUrlError";
  }
}

/** Thrown when a guarded request could not be completed (timeout, DNS, transport, redirects). */
export class GuardedFetchError extends Error {
  constructor(
    readonly code: "timeout" | "dns" | "too_many_redirects" | "network",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GuardedFetchError";
  }
}

export interface AddressInfo {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to ALL of its addresses. */
export type LookupFn = (hostname: string) => Promise<AddressInfo[]>;

/** What counts as an allowed destination. Production uses the defaults; tests inject. */
export interface GuardPolicy {
  /** DNS resolver. Default: the system resolver (`getaddrinfo`, honours /etc/hosts). */
  lookup?: LookupFn;
  /**
   * Whether a resolved (or literal) address may be contacted. Default: globally routable
   * and not one of this machine's own interface addresses. Overriding this REMOVES the
   * protection — it exists so tests can talk to a server on 127.0.0.1.
   */
  isAllowedAddress?: (address: string) => boolean;
}

// ---- Address classification -------------------------------------------------

type Cidr = readonly [prefix: Uint8Array, bits: number, label: string];

function parseIpv4(s: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(m[i + 1]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(input: string): Uint8Array | null {
  let s = input.replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone); // fe80::1%eth0
  if (isIP(s) !== 6) return null;
  // A dotted-quad tail (::ffff:127.0.0.1) occupies the last two groups.
  let tail: Uint8Array | null = null;
  if (s.includes(".")) {
    const cut = s.lastIndexOf(":");
    tail = parseIpv4(s.slice(cut + 1));
    if (!tail) return null;
    s = `${s.slice(0, cut + 1)}0:0`;
  }
  const [head, rest] = s.split("::") as [string, string | undefined];
  const headGroups = head ? head.split(":") : [];
  const restGroups = rest ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - headGroups.length - restGroups.length;
  if (fill < 0 || headGroups.length + restGroups.length + fill !== 8) return null;
  const groups = [...headGroups, ...new Array<string>(fill).fill("0"), ...restGroups];
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i]!, 16);
    if (!Number.isFinite(n)) return null;
    out[i * 2] = n >> 8;
    out[i * 2 + 1] = n & 0xff;
  }
  if (tail) out.set(tail, 12);
  return out;
}

function cidr(prefix: string, bits: number, label: string): Cidr {
  const bytes = parseIpv4(prefix) ?? parseIpv6(prefix);
  if (!bytes) throw new Error(`bad CIDR prefix ${prefix}`);
  return [bytes, bits, label];
}

function inCidr(addr: Uint8Array, [prefix, bits]: Cidr): boolean {
  if (addr.length !== prefix.length) return false;
  const whole = bits >> 3;
  for (let i = 0; i < whole; i++) if (addr[i] !== prefix[i]) return false;
  const rem = bits & 7;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return (addr[whole]! & mask) === (prefix[whole]! & mask);
}

// Everything that is not a globally-routable unicast address.
const NON_PUBLIC_V4: Cidr[] = [
  cidr("0.0.0.0", 8, "unspecified (this host)"),
  cidr("10.0.0.0", 8, "private network"),
  cidr("100.64.0.0", 10, "carrier-grade NAT"),
  cidr("127.0.0.0", 8, "loopback"),
  cidr("169.254.0.0", 16, "link-local (cloud metadata)"),
  cidr("172.16.0.0", 12, "private network"),
  cidr("192.0.0.0", 24, "IETF protocol assignments"),
  cidr("192.0.2.0", 24, "documentation range"),
  cidr("192.88.99.0", 24, "6to4 relay"),
  cidr("192.168.0.0", 16, "private network"),
  cidr("198.18.0.0", 15, "benchmarking range"),
  cidr("198.51.100.0", 24, "documentation range"),
  cidr("203.0.113.0", 24, "documentation range"),
  cidr("224.0.0.0", 4, "multicast"),
  cidr("240.0.0.0", 4, "reserved / broadcast"),
];
const NON_PUBLIC_V6: Cidr[] = [
  cidr("::", 128, "unspecified"),
  cidr("::1", 128, "loopback"),
  cidr("64:ff9b:1::", 48, "local-use NAT64"),
  cidr("100::", 64, "discard-only"),
  cidr("2001::", 23, "IETF protocol assignments (Teredo etc.)"),
  cidr("2001:db8::", 32, "documentation range"),
  cidr("3fff::", 20, "documentation range"),
  cidr("fc00::", 7, "unique-local (private) IPv6"),
  cidr("fe80::", 10, "link-local"),
  cidr("fec0::", 10, "site-local"),
  cidr("ff00::", 8, "multicast"),
];
// IPv6 forms that CARRY an IPv4 address: judge the IPv4 address they carry.
const V4_MAPPED = cidr("::ffff:0:0", 96, "IPv4-mapped");
const V4_COMPATIBLE = cidr("::", 96, "IPv4-compatible");
const NAT64 = cidr("64:ff9b::", 96, "NAT64");
const SIX_TO_FOUR = cidr("2002::", 16, "6to4");

function v4Reason(bytes: Uint8Array): string | null {
  return NON_PUBLIC_V4.find((c) => inCidr(bytes, c))?.[2] ?? null;
}

/**
 * Why an IP address is NOT a public internet destination, or null when it is one.
 * Covers private, loopback, link-local (incl. the 169.254.169.254 metadata endpoint),
 * CGNAT, multicast/reserved, IPv6 ULA / link-local, and every IPv6 spelling that wraps
 * an IPv4 address (mapped, compatible, NAT64, 6to4). A string that is not an IP at all
 * is refused too.
 */
export function ipBlockReason(address: string): string | null {
  const literal = address.replace(/^\[|\]$/g, "");
  const v4 = parseIpv4(literal);
  if (v4) return v4Reason(v4);
  const v6 = parseIpv6(literal);
  if (!v6) return "not an IP address";
  const embedded = inCidr(v6, V4_MAPPED) || inCidr(v6, NAT64) ? v6.subarray(12, 16) : inCidr(v6, SIX_TO_FOUR) ? v6.subarray(2, 6) : null;
  if (embedded) {
    const reason = v4Reason(embedded);
    return reason ? `${reason} (IPv4 ${embedded.join(".")} inside an IPv6 address)` : null;
  }
  const direct = NON_PUBLIC_V6.find((c) => inCidr(v6, c))?.[2];
  if (direct) return direct;
  if (inCidr(v6, V4_COMPATIBLE)) return "IPv4-compatible IPv6 (deprecated)";
  return null;
}

/** True when `address` is a globally-routable public IP (v4 or v6). */
export function isPublicIp(address: string): boolean {
  return ipBlockReason(address) === null;
}

let ownAddressCache: { at: number; set: Set<string> } | null = null;
/** This machine's own interface addresses (a public IP bound to eth0 is still "us"). */
function ownAddresses(): Set<string> {
  const now = Date.now();
  if (ownAddressCache && now - ownAddressCache.at < 60_000) return ownAddressCache.set;
  const set = new Set<string>();
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const i of list ?? []) set.add(i.address.replace(/%.*$/, "").toLowerCase());
    }
  } catch {
    /* no interface info — the range checks still apply */
  }
  ownAddressCache = { at: now, set };
  return set;
}

function defaultAddressReason(address: string): string | null {
  const reason = ipBlockReason(address);
  if (reason) return reason;
  return ownAddresses().has(address.replace(/^\[|\]$/g, "").toLowerCase()) ? "this machine's own address" : null;
}

// ---- URL screening ----------------------------------------------------------

// Names that only mean something inside a private network.
const INTERNAL_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".intranet", ".home.arpa"];

function screen(u: URL, policy: GuardPolicy): string | null {
  if (u.protocol !== "http:" && u.protocol !== "https:") return `scheme "${u.protocol}" is not allowed`;
  if (u.username || u.password) return "credentials embedded in the URL";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return "empty host";
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (policy.isAllowedAddress) return policy.isAllowedAddress(literal) ? null : "address not allowed";
    return defaultAddressReason(literal);
  }
  if (host === "localhost" || INTERNAL_NAME_SUFFIXES.some((s) => host.endsWith(s))) return "internal hostname";
  if (!host.includes(".")) return "single-label hostname (an intranet/service name)";
  return null;
}

/**
 * Screen a URL WITHOUT touching the network: scheme, embedded credentials, internal
 * hostnames, and IP literals in any spelling (`http://2130706433/`, `http://0x7f.1/`,
 * `http://[::ffff:127.0.0.1]/` are all 127.0.0.1). Returns the reason it is unsafe, or
 * null. A hostname that only RESOLVES to a private address passes this check and is
 * caught by {@link assertPublicUrl} / {@link guardedFetch} — use this for cheap,
 * synchronous validation of user input, never as the only gate before a request.
 */
export function unsafeUrlReason(rawUrl: string | URL): string | null {
  let u: URL;
  try {
    u = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  } catch {
    return "not a valid absolute URL";
  }
  return screen(u, {});
}

async function systemLookup(hostname: string): Promise<AddressInfo[]> {
  const found = await dnsLookup(hostname, { all: true, verbatim: true });
  return found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
}

/**
 * Full check of one URL: {@link unsafeUrlReason} plus DNS — every address the host
 * resolves to must be allowed. Returns the parsed URL and the vetted addresses (connect
 * to THESE, not to a fresh lookup). Throws {@link UnsafeUrlError} when refused and
 * {@link GuardedFetchError} (`dns`) when the name does not resolve.
 */
export async function assertPublicUrl(rawUrl: string | URL, policy: GuardPolicy = {}): Promise<{ url: URL; addresses: AddressInfo[] }> {
  const text = typeof rawUrl === "string" ? rawUrl : rawUrl.toString();
  let url: URL;
  try {
    url = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  } catch {
    throw new UnsafeUrlError(text, "not a valid absolute URL");
  }
  const reason = screen(url, policy);
  if (reason) throw new UnsafeUrlError(text, reason);

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) return { url, addresses: [{ address: literal, family: isIP(literal) === 6 ? 6 : 4 }] };

  let addresses: AddressInfo[];
  try {
    addresses = await (policy.lookup ?? systemLookup)(host);
  } catch (err) {
    throw new GuardedFetchError("dns", `could not resolve ${host}`, { cause: err });
  }
  if (addresses.length === 0) throw new GuardedFetchError("dns", `${host} has no addresses`);
  // ALL of them must pass: with a mixed answer the connection could land on the private one.
  for (const a of addresses) {
    const bad = policy.isAllowedAddress ? (policy.isAllowedAddress(a.address) ? null : "address not allowed") : defaultAddressReason(a.address);
    if (bad) throw new UnsafeUrlError(text, `${host} resolves to ${a.address} — ${bad}`);
  }
  return { url, addresses };
}

/**
 * The same check for a bare HOST that is about to be connected to by something other
 * than HTTP — a tenant-entered SMTP or IMAP server, say. Returns the vetted addresses;
 * throws like {@link assertPublicUrl}.
 */
export async function assertPublicHost(host: string, policy: GuardPolicy = {}): Promise<AddressInfo[]> {
  const bare = host.trim().replace(/^\[|\]$/g, "");
  if (!bare || /[\s/@?#]/.test(bare)) throw new UnsafeUrlError(host, "not a hostname");
  const { addresses } = await assertPublicUrl(`https://${isIP(bare) === 6 ? `[${bare}]` : bare}/`, policy);
  return addresses;
}

// ---- Guarded fetch ----------------------------------------------------------

/** One request to one already-vetted URL. A transport NEVER follows redirects. */
export interface HopRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** The addresses the guard vetted for this host — a direct transport must connect to these. */
  addresses: AddressInfo[];
  signal: AbortSignal;
  maxBodyBytes: number;
  /** Whether to read the body of this response (false for a redirect about to be followed, an unwanted content type, …). */
  wantBody: (status: number, headers: Record<string, string>) => boolean;
}

export interface HopResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
  /** True when the body was cut at `maxBodyBytes`. */
  truncated: boolean;
}

export type GuardedTransport = (hop: HopRequest) => Promise<HopResponse>;

export interface GuardedFetchOptions extends GuardPolicy {
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  /** Deadline for the WHOLE exchange, redirects included. Default 15 s. */
  timeoutMs?: number;
  /** Bytes of (decoded) body to keep; the rest is dropped and `truncated` set. Default 2 MB. */
  maxBodyBytes?: number;
  /** Redirects to follow, each re-checked. 0 = return the 3xx as-is. Default 5. */
  maxRedirects?: number;
  /** Follow redirects but never download a body (resolving where a link lands). */
  discardBody?: boolean;
  /** Read the body only when the content type passes (e.g. skip images/PDFs/video). */
  acceptContentType?: (contentType: string | null) => boolean;
  /** How one hop is carried out. Default: a direct connection pinned to the vetted address. */
  transport?: GuardedTransport;
}

export interface GuardedResponse extends HopResponse {
  /** The URL that produced this response (after redirects). */
  url: string;
  /** Every URL redirected THROUGH, in order (empty when there was no redirect). */
  redirects: string[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 2_000_000;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Fetch a URL that came from outside (see the module comment). Throws
 * {@link UnsafeUrlError} if the URL or ANY redirect hop is not a public destination,
 * {@link GuardedFetchError} on timeout / DNS / transport failure / too many redirects.
 * A non-2xx status is returned, not thrown.
 */
export async function guardedFetch(rawUrl: string, opts: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  const transport = opts.transport ?? directTransport;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const redirects: string[] = [];

  let method: string = opts.method ?? "GET";
  let body = opts.body;
  let headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let current: string | URL = rawUrl;

  for (let hop = 0; ; hop++) {
    // The system resolver cannot be cancelled, so the deadline is raced against it.
    const { url, addresses } = await beforeDeadline(assertPublicUrl(current, opts), signal, timeoutMs);
    const followable = hop < maxRedirects;
    let res: HopResponse;
    try {
      res = await transport({
        url,
        method,
        headers,
        body,
        addresses,
        signal,
        maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        wantBody: (status, h) => {
          if (opts.discardBody || method === "HEAD") return false;
          if (followable && REDIRECT_STATUSES.has(status) && h.location) return false;
          return opts.acceptContentType ? opts.acceptContentType(h["content-type"] ?? null) : true;
        },
      });
    } catch (err) {
      if (err instanceof UnsafeUrlError || err instanceof GuardedFetchError) throw err;
      if (signal.aborted) throw new GuardedFetchError("timeout", `no response from ${url.host} within ${timeoutMs} ms`, { cause: err });
      throw new GuardedFetchError("network", `request to ${url.host} failed: ${(err as Error)?.message ?? String(err)}`, { cause: err });
    }

    const location = res.headers.location;
    if (!REDIRECT_STATUSES.has(res.status) || !location || maxRedirects === 0) {
      return { ...res, url: url.toString(), redirects };
    }
    if (!followable) throw new GuardedFetchError("too_many_redirects", `more than ${maxRedirects} redirects from ${redactUrl(rawUrl)}`);

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new UnsafeUrlError(location, "redirect to an unparseable location");
    }
    // 303 always becomes GET; 301/302 turn a POST into a GET (what every client does).
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers = withoutHeaders(headers, ["content-type", "content-length"]);
    }
    // Never carry credentials-like headers to a different origin.
    if (next.origin !== url.origin) headers = withoutHeaders(headers, ["authorization", "cookie", "proxy-authorization"]);
    redirects.push(next.toString());
    current = next;
  }
}

function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted) return Promise.reject(new GuardedFetchError("timeout", `deadline of ${timeoutMs} ms passed`));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new GuardedFetchError("timeout", `deadline of ${timeoutMs} ms passed`));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function withoutHeaders(headers: Record<string, string>, drop: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (!drop.includes(k.toLowerCase())) out[k] = v;
  return out;
}

/** A URL safe to put in a log line or error message: no credentials, no query string. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
  }
}

// ---- Default transport: direct, pinned to the vetted address -----------------

/** A `lookup` that hands the socket exactly the addresses the guard approved. */
function pinnedLookup(addresses: AddressInfo[]): LookupFunction {
  const fn = (_hostname: string, options: unknown, callback?: unknown): void => {
    const cb = (typeof options === "function" ? options : callback) as (err: Error | null, address?: unknown, family?: number) => void;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
    process.nextTick(() => {
      if (all) cb(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      else cb(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
  return fn as unknown as LookupFunction;
}

/**
 * Direct connection from this machine, with the socket pinned to the vetted addresses
 * (the hostname is still used for the Host header, SNI and certificate check). One
 * connection per request; never follows redirects.
 */
export const directTransport: GuardedTransport = (hop) =>
  new Promise<HopResponse>((resolve, reject) => {
    const secure = hop.url.protocol === "https:";
    const host = hop.url.hostname.replace(/^\[|\]$/g, "");
    const headers: Record<string, string> = { "accept-encoding": "gzip, deflate, br", ...hop.headers };
    if (hop.body != null) headers["content-length"] = String(Buffer.byteLength(hop.body));
    const options: https.RequestOptions = {
      protocol: hop.url.protocol,
      host,
      port: hop.url.port ? Number(hop.url.port) : secure ? 443 : 80,
      path: `${hop.url.pathname}${hop.url.search}`,
      method: hop.method,
      headers,
      agent: false,
      signal: hop.signal,
      ...(isIP(host) ? {} : { lookup: pinnedLookup(hop.addresses) }),
    };
    const onResponse = (res: http.IncomingMessage): void => {
      readResponse(res, hop).then(resolve, reject);
    };
    const req = secure ? https.request(options, onResponse) : http.request(options, onResponse);
    req.on("error", reject);
    if (hop.body != null) req.write(hop.body);
    req.end();
  });

async function readResponse(res: http.IncomingMessage, hop: HopRequest): Promise<HopResponse> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v != null) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  const status = res.statusCode ?? 0;
  // Nothing to read (and nothing to hand a decompressor, which would fail on empty input).
  const bodiless = status === 204 || status === 304 || headers["content-length"] === "0";
  if (bodiless || !hop.wantBody(status, headers)) {
    res.destroy();
    return { status, headers, body: "", truncated: false };
  }

  const encoding = (headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? zlib.createGunzip()
      : encoding === "deflate"
        ? zlib.createInflate()
        : encoding === "br"
          ? zlib.createBrotliDecompress()
          : null;
  let stream: NodeJS.ReadableStream = res;
  if (decoder) {
    res.on("error", (err) => decoder.destroy(err));
    stream = res.pipe(decoder);
  }

  // The cap is on DECODED bytes, so a small compressed body cannot expand without bound.
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      const room = hop.maxBodyBytes - size;
      if (buf.length > room) {
        if (room > 0) chunks.push(buf.subarray(0, room));
        truncated = true;
        break;
      }
      chunks.push(buf);
      size += buf.length;
    }
  } finally {
    res.destroy();
  }
  return { status, headers, body: Buffer.concat(chunks).toString("utf8"), truncated };
}
