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
