import type { RedirectResolver, EmailVerifier } from "./ports.js";

/**
 * Real, network-backed evidence helpers (Section 8.1/8.2). These are NOT stubs:
 * they actually follow redirects and do DNS MX lookups. They run only when the
 * real discovery path is configured; with no network they fail safely (return
 * null / not-deliverable) rather than inventing a positive result.
 */

/** Follows redirects to confirm where a generic affiliate link (`?ref=`, `?via=`) lands. */
export class FetchRedirectResolver implements RedirectResolver {
  readonly kind = "fetch";
  constructor(private readonly opts: { timeoutMs?: number } = {}) {}

  async resolve(url: string): Promise<{ finalUrl: string; finalHost: string } | null> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8000);
    try {
      // GET with redirect:follow — fetch exposes the FINAL url on res.url.
      const res = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { "User-Agent": "VantageBot/1.0" } });
      const finalUrl = res.url || url;
      const finalHost = new URL(finalUrl).hostname.replace(/^www\./, "");
      return { finalUrl, finalHost };
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * Real email verification via DNS MX records. A deliverable address requires a
 * domain with MX (or A) records that accept mail. This is the floor; a full
 * verifier also does an SMTP RCPT probe (provider-dependent, often rate-limited).
 */
export class MxEmailVerifier implements EmailVerifier {
  readonly kind = "mx";
  private readonly cache = new Map<string, boolean>();

  async verify(email: string): Promise<{ deliverable: boolean; reason: string }> {
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { deliverable: false, reason: "malformed address" };
    if (this.cache.has(domain)) return { deliverable: this.cache.get(domain)!, reason: "mx (cached)" };
    try {
      const dns = await import("node:dns/promises");
      let hasMail = false;
      try {
        const mx = await dns.resolveMx(domain);
        hasMail = mx.length > 0;
      } catch {
        // No MX — some domains accept mail on the A record.
        try {
          const a = await dns.resolve4(domain);
          hasMail = a.length > 0;
        } catch {
          hasMail = false;
        }
      }
      this.cache.set(domain, hasMail);
      return { deliverable: hasMail, reason: hasMail ? "mx record present" : "no mail server for domain" };
    } catch {
      return { deliverable: false, reason: "dns lookup failed" };
    }
  }
}

/** A verifier for environments with no real DNS — used only in dev/test. */
export class NoopEmailVerifier implements EmailVerifier {
  readonly kind = "noop";
  async verify(): Promise<{ deliverable: boolean; reason: string }> {
    return { deliverable: false, reason: "no verifier configured" };
  }
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/**
 * Obfuscated-email pattern: `local <at> domain <dot> tld`, where <at>/<dot> are
 * bracketed words (`[at]`, `(dot)`), bare UPPERCASE words (`AT`, `DOT` — the
 * deliberate-obfuscation signal), or spaced punctuation (` @ `, ` . `). Case-
 * SENSITIVE on purpose so prose like "look at the dot-com era" doesn't match —
 * the bare-word forms must be uppercase. The domain group is greedy so multi-part
 * domains (`sub.example DOT com`) reconstruct correctly.
 */
const OBFUSCATED_RE = new RegExp(
  String.raw`([a-zA-Z0-9._%+-]+)` +
    String.raw`(?:\s*[\[\(\{]\s*[aA][tT]\s*[\]\)\}]\s*|\s+AT\s+|\s+@\s+)` +
    String.raw`([a-zA-Z0-9.-]+)` +
    String.raw`(?:\s*[\[\(\{]\s*[dD][oO][tT]\s*[\]\)\}]\s*|\s+DOT\s+|\s+\.\s+)` +
    String.raw`([a-zA-Z]{2,})`,
  "g",
);

export type EmailSource = "mailto" | "page" | "obfuscated" | "cfemail";

/**
 * Extract contact emails from page HTML. Reads what a human could find: mailto:
 * links, visible addresses, HTML-entity-encoded addresses, Cloudflare-protected
 * addresses (`data-cfemail`), and human-readable obfuscations (`name [at] site
 * [dot] com`). Filters out asset/tracking junk. REAL extraction, never guessing —
 * if nothing is on the page, it returns nothing. JS-assembled addresses (built at
 * runtime by scripts) need a headless-browser fetcher to render first; those are
 * out of scope for static HTML.
 */
export function extractEmailsFromHtml(html: string): { email: string; source: EmailSource }[] {
  const out: { email: string; source: EmailSource }[] = [];
  const seen = new Set<string>();
  const add = (raw: string, source: EmailSource) => {
    const e = raw.replace(/\s+/g, "").toLowerCase();
    if (isPlausibleEmail(e) && !seen.has(e)) {
      seen.add(e);
      out.push({ email: e, source });
    }
  };

  // 1) Cloudflare email protection — decode the XOR-encoded hex from the raw HTML.
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-fA-F]{4,})["']/g)) {
    const decoded = decodeCfEmail(m[1]!);
    if (decoded) add(decoded, "cfemail");
  }

  // Decode HTML entities so fully entity-encoded addresses (&#106;&#64;…) read back.
  const text = decodeHtmlEntities(html);

  // 2) mailto: links (highest intent). 3) visible addresses. 4) obfuscations.
  for (const m of text.matchAll(/mailto:([^"'?>\s]+)/gi)) add(m[1]!, "mailto");
  for (const m of text.matchAll(EMAIL_RE)) add(m[0], "page");
  for (const m of text.matchAll(OBFUSCATED_RE)) add(`${m[1]}@${m[2]}.${m[3]}`, "obfuscated");

  return out;
}

/** Decode numeric/hex HTML entities (covers entity-encoded email obfuscation). */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&(?:commat|#0*64);/gi, "@")
    .replace(/&(?:period|dot);/gi, ".");
}

function safeFromCode(code: number): string {
  return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
}

/**
 * Decode a Cloudflare-obfuscated email. CF stores the address as hex where the
 * first byte is an XOR key and every subsequent byte is the key XOR the character.
 */
function decodeCfEmail(hex: string): string {
  if (hex.length < 4 || hex.length % 2 !== 0) return "";
  const key = parseInt(hex.slice(0, 2), 16);
  let email = "";
  for (let i = 2; i < hex.length; i += 2) {
    email += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return email;
}

function isPlausibleEmail(e: string): boolean {
  if (e.length > 100) return false;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(e)) return false;
  if (/^(noreply|no-reply|donotreply)@/i.test(e)) return false;
  if (/(sentry|wixpress|example|domain|your-?email|email@)/i.test(e)) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(e);
}

// ---- Secondary contact surfaces (Section 8.2) ------------------------------
// Creators rarely put a raw email on the homepage; they put it on a Linktree-style
// bio page, a /contact or /work-with-me page, or their YouTube About tab. These
// helpers find those pages from the links a creator actually placed, so the enrich
// stage can fetch them and run the same real extraction — more free, real emails
// before paying a finder.

const BIO_HOSTS = [
  "linktr.ee", "beacons.ai", "bio.link", "solo.to", "lnk.bio", "carrd.co", "tap.bio",
  "withkoji.com", "koji.to", "msha.ke", "linkpop.com", "komi.io", "snipfeed.co",
  "stan.store", "flowcode.com", "shor.by", "campsite.bio", "many.link", "pillar.io",
];
const CONTACT_PATH_RE = /\/(contact|about|work-with-me|collaborat|sponsor|advertis|partnership|press|media-?kit|pr-?inquir|business)/i;

export type ContactUrlKind = "bio_aggregator" | "contact_page" | "youtube_about";
export interface ContactUrl {
  url: string;
  kind: ContactUrlKind;
}

/** All href targets on a page, absolutized against the base URL (for the identity graph). */
export function extractHrefs(html: string, baseUrl?: string | null): string[] {
  const base = safeBase(baseUrl);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const abs = absolutize(m[1]!, base);
    if (abs && !seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

function safeBase(b?: string | null): URL | null {
  if (!b) return null;
  try {
    return new URL(b.startsWith("http") ? b : `https://${b}`);
  } catch {
    return null;
  }
}

function absolutize(url: string, base: URL | null): string | null {
  try {
    if (/^(mailto:|tel:|javascript:|data:|#)/i.test(url)) return null;
    const u = base ? new URL(url, base) : new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * From a page's HTML, surface the contact-bearing pages the creator actually
 * linked: bio aggregators (Linktree/Beacons/…), same-site contact/about/collab
 * pages, and the YouTube About tab. Prioritized and capped; the enrich stage
 * fetches these and runs `extractEmailsFromHtml` over each.
 */
export function discoverContactUrls(html: string, baseUrl?: string | null): ContactUrl[] {
  const base = safeBase(baseUrl);
  const out: ContactUrl[] = [];
  const seen = new Set<string>();
  const push = (raw: string, kind: ContactUrlKind) => {
    const abs = absolutize(raw, base);
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    out.push({ url: abs, kind });
  };

  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const abs = absolutize(m[1]!, base);
    if (!abs) continue;
    let host: string;
    let path: string;
    try {
      const u = new URL(abs);
      host = u.hostname.replace(/^www\./, "").toLowerCase();
      path = u.pathname;
    } catch {
      continue;
    }
    if (BIO_HOSTS.some((b) => host === b || host.endsWith(`.${b}`))) {
      push(abs, "bio_aggregator");
    } else if (host.endsWith("youtube.com") && /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(path)) {
      push(`${abs.replace(/\/+$/, "")}/about`, "youtube_about");
    } else if (base && host === base.hostname.replace(/^www\./, "").toLowerCase() && CONTACT_PATH_RE.test(path)) {
      push(abs, "contact_page");
    }
  }

  const rank: Record<ContactUrlKind, number> = { bio_aggregator: 0, contact_page: 1, youtube_about: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 6);
}

/**
 * Heuristic: does this page have a contact FORM (rather than a raw email)? True
 * when a form is explicitly a contact form, or contains both an email field and a
 * message/textarea field. Used to route form-only prospects to the human gate with
 * a pre-drafted message (we do not auto-submit).
 */
export function detectsContactForm(html: string): boolean {
  if (/<form[^>]*(?:id|class|name|action)\s*=\s*["'][^"']*(contact|inquir|message|reach|connect|collaborat)[^"']*["']/i.test(html)) {
    return true;
  }
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) ?? [];
  for (const f of forms) {
    const hasEmail = /type\s*=\s*["']email["']|name\s*=\s*["'][^"']*e-?mail/i.test(f);
    const hasMessage = /<textarea|name\s*=\s*["'][^"']*(message|comment|inquiry|body|note)/i.test(f);
    if (hasEmail && hasMessage) return true;
  }
  return false;
}
