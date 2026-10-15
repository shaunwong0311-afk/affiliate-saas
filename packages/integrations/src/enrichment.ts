import { createHash } from "node:crypto";
import type { EmailCandidate, EmailFinder } from "./ports.js";
import { assertProviderOk } from "./http.js";

/**
 * Email discovery + verification (Section 8.2). Three finders behind one port:
 *
 *  - {@link HunterFinder} — a real lookup (key-gated).
 *  - {@link NullEmailFinder} — "no finder is configured": finds nothing, verifies
 *    nothing. What a real deployment without a Hunter key runs, so the honest outcome
 *    there is "no contact found".
 *  - {@link StubEmailFinder} — the DEMO stub. It invents plausible addresses so the
 *    demo pipeline has something to show. It declares `guesses`, and the pipeline lets
 *    it act only on synthetic (demo) prospects — its output is never "verified".
 *
 * Verify before sending — unverified sends destroy deliverability.
 */

const PATTERNS = (first: string, last: string) => [
  `${first}.${last}`,
  `${first}${last}`,
  `${first[0] ?? ""}${last}`,
  `${first}`,
];

export class StubEmailFinder implements EmailFinder {
  readonly name = "stub-finder";
  /** Fabricates addresses from a name pattern — demo data only (see the EmailFinder port). */
  readonly guesses = true;

  async find(input: { fullName?: string; domain?: string; siteUrl?: string }): Promise<EmailCandidate[]> {
    const domain = input.domain ?? hostOf(input.siteUrl) ?? "example.com";
    const [first = "info", last = "team"] = (input.fullName ?? "info team").toLowerCase().split(/\s+/);
    return PATTERNS(first, last).map((local, i) => {
      const email = `${local}@${domain}`;
      const confidence = Math.max(0.2, 0.9 - i * 0.15);
      return { email, confidence, verified: false, source: this.name };
    });
  }

  async verify(email: string): Promise<{ deliverable: boolean; reason: string }> {
    if (/bounce|invalid|noexist/i.test(email)) return { deliverable: false, reason: "mailbox not found" };
    // Deterministic: ~75% deliverable based on a hash, so verification varies.
    const h = createHash("md5").update(email).digest()[0]!;
    return h % 4 === 0 ? { deliverable: false, reason: "catch-all/unverifiable" } : { deliverable: true, reason: "smtp ok" };
  }
}

/**
 * No finder configured: nothing is found, and it is not a verifier (addresses found on a
 * page are then confirmed by the MX check alone). Never invents.
 */
export class NullEmailFinder implements EmailFinder {
  readonly name = "none";
  readonly verifies = false;
  async find(): Promise<EmailCandidate[]> {
    return [];
  }
  async verify(): Promise<{ deliverable: boolean; reason: string }> {
    return { deliverable: false, reason: "no email finder configured" };
  }
}

/** Hunter.io adapter skeleton (real shape; requires API key + HTTP client). */
export interface HttpClient {
  get(url: string, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
}

/**
 * UNVALIDATED against the live API (AUDIT-2026-10 D16). Known mismatch to fix on the
 * first real run: `find` calls Hunter's EMAIL-FINDER, which needs a PERSON's first and
 * last name plus a domain — but the pipeline passes the prospect's `identity`, which is
 * a page title or a domain ("skinblog.com", "Best Skincare — review 3"), almost never a
 * person. Expect it to return nothing for most prospects. Hunter's DOMAIN-SEARCH
 * endpoint (addresses seen at a domain, no name needed) is the one that fits how this
 * is called; switching needs its real response in hand, so it is not done blind here.
 *
 * What IS handled: a non-2xx answer (401 bad key, 429 rate/plan limit) throws a
 * ProviderError instead of reading as "no email found" / "not deliverable".
 */
export class HunterFinder implements EmailFinder {
  readonly name = "hunter";
  constructor(private readonly opts: { apiKey: string; http?: HttpClient }) {}

  async find(input: { fullName?: string; domain?: string }): Promise<EmailCandidate[]> {
    if (!this.opts.http) throw new Error("hunter not configured");
    if (!input.domain) return []; // the endpoint cannot be asked without a domain
    const res = await this.opts.http.get(
      `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(input.domain)}&full_name=${encodeURIComponent(input.fullName ?? "")}&api_key=${this.opts.apiKey}`,
    );
    assertProviderOk("hunter", res, hunterMessage);
    const d = res.json?.data;
    return d?.email ? [{ email: d.email, confidence: (d.score ?? 0) / 100, verified: d.verification?.status === "valid", source: this.name }] : [];
  }

  async verify(email: string): Promise<{ deliverable: boolean; reason: string }> {
    if (!this.opts.http) throw new Error("hunter not configured");
    const res = await this.opts.http.get(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${this.opts.apiKey}`);
    assertProviderOk("hunter", res, hunterMessage);
    const status = res.json?.data?.status;
    return { deliverable: status === "valid", reason: status ?? "unknown" };
  }
}

function hunterMessage(json: any): unknown {
  return json?.errors?.[0]?.details ?? json?.errors?.[0]?.id;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
