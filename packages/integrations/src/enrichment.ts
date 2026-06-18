import { createHash } from "node:crypto";
import type { EmailCandidate, EmailFinder } from "./ports.js";

/**
 * Email discovery + verification (Section 8.2). Pattern generation plus
 * verification; in production these route to Hunter/Apollo/Findymail/Prospeo with
 * MX/SMTP verification. Verify before sending — unverified sends destroy
 * deliverability. The stub is deterministic so the pipeline produces stable
 * contact records in dev/test.
 */

const PATTERNS = (first: string, last: string) => [
  `${first}.${last}`,
  `${first}${last}`,
  `${first[0] ?? ""}${last}`,
  `${first}`,
];

export class StubEmailFinder implements EmailFinder {
  readonly name = "stub-finder";

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

/** Hunter.io adapter skeleton (real shape; requires API key + HTTP client). */
export interface HttpClient {
  get(url: string, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
}

export class HunterFinder implements EmailFinder {
  readonly name = "hunter";
  constructor(private readonly opts: { apiKey: string; http?: HttpClient }) {}

  async find(input: { fullName?: string; domain?: string }): Promise<EmailCandidate[]> {
    if (!this.opts.http) throw new Error("hunter not configured");
    const res = await this.opts.http.get(
      `https://api.hunter.io/v2/email-finder?domain=${input.domain}&full_name=${encodeURIComponent(input.fullName ?? "")}&api_key=${this.opts.apiKey}`,
    );
    const d = res.json?.data;
    return d?.email ? [{ email: d.email, confidence: (d.score ?? 0) / 100, verified: d.verification?.status === "valid", source: this.name }] : [];
  }

  async verify(email: string): Promise<{ deliverable: boolean; reason: string }> {
    if (!this.opts.http) throw new Error("hunter not configured");
    const res = await this.opts.http.get(`https://api.hunter.io/v2/email-verifier?email=${email}&api_key=${this.opts.apiKey}`);
    const status = res.json?.data?.status;
    return { deliverable: status === "valid", reason: status ?? "unknown" };
  }
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
