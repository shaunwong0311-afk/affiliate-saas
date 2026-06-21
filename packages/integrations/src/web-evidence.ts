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
 * Extract contact emails from page HTML — mailto: links first (highest signal),
 * then visible addresses. Filters out asset/tracking junk. This is REAL contact
 * extraction, not pattern-guessing.
 */
export function extractEmailsFromHtml(html: string): { email: string; source: "mailto" | "page" }[] {
  const out: { email: string; source: "mailto" | "page" }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = m[1]!.toLowerCase();
    if (isPlausibleEmail(e) && !seen.has(e)) {
      seen.add(e);
      out.push({ email: e, source: "mailto" });
    }
  }
  for (const m of html.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase();
    if (isPlausibleEmail(e) && !seen.has(e)) {
      seen.add(e);
      out.push({ email: e, source: "page" });
    }
  }
  return out;
}

function isPlausibleEmail(e: string): boolean {
  if (e.length > 100) return false;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(e)) return false;
  if (/^(noreply|no-reply|donotreply)@/i.test(e)) return false;
  if (/(sentry|wixpress|example|domain|your-?email|email@)/i.test(e)) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(e);
}
