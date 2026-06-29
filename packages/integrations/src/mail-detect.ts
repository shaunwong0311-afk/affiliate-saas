/**
 * Smart Connect provider detection (OUTREACH-SPEC §3). The merchant enters their email and
 * we route them to the EASIEST connection method by looking up the domain's MX records —
 * because most "custom domain" business email is actually Google Workspace or Microsoft 365
 * underneath, and those get a one-click/app-password path instead of a raw SMTP form.
 *
 *   Google (Workspace/Gmail)  → app-password wizard now (one-click OAuth later)
 *   Microsoft (M365/Outlook)  → Graph OAuth (basic-auth SMTP is retired)
 *   anything else             → generic SMTP, PRE-FILLED from presets / mail.{domain}
 *
 * Pure aside from one DNS MX lookup, which is injectable for offline tests.
 */

export type MailProviderKind = "google" | "microsoft" | "smtp";
export type ConnectMethod = "google_oauth" | "google_app_password" | "microsoft_oauth" | "smtp";

export interface DetectedProvider {
  kind: MailProviderKind;
  /** The connection method to surface to the merchant. */
  method: ConnectMethod;
  /** Pre-filled SMTP settings where known (so the merchant only enters a password). */
  smtp?: { host: string; port: number; secure: boolean };
  /** Pre-filled IMAP settings for reply ingestion on the SMTP rail. */
  imap?: { host: string; port: number };
  /** Short human note for the UI. */
  note: string;
}

type MxResolver = (domain: string) => Promise<{ exchange: string }[]>;

const FREE_GOOGLE = new Set(["gmail.com", "googlemail.com"]);
const FREE_MICROSOFT = new Set(["outlook.com", "hotmail.com", "live.com", "msn.com"]);

// Known self-hosted providers → exact SMTP/IMAP so the merchant only types a password.
const SMTP_PRESETS: Record<string, { smtp: { host: string; port: number; secure: boolean }; imap: { host: string; port: number } }> = {
  "zoho.com": { smtp: { host: "smtp.zoho.com", port: 465, secure: true }, imap: { host: "imap.zoho.com", port: 993 } },
  "fastmail.com": { smtp: { host: "smtp.fastmail.com", port: 465, secure: true }, imap: { host: "imap.fastmail.com", port: 993 } },
};

const GMAIL_SMTP = { host: "smtp.gmail.com", port: 587, secure: false };
const GMAIL_IMAP = { host: "imap.gmail.com", port: 993 };

function smtpFallback(domain: string): DetectedProvider {
  // Convention most hosts follow; the merchant can correct it before testing.
  return {
    kind: "smtp",
    method: "smtp",
    smtp: { host: `mail.${domain}`, port: 587, secure: false },
    imap: { host: `mail.${domain}`, port: 993 },
    note: "Self-hosted email — confirm the server settings (pre-filled) and enter your mailbox password.",
  };
}

async function defaultResolveMx(domain: string): Promise<{ exchange: string }[]> {
  const dns = await import("node:dns/promises");
  return dns.resolveMx(domain);
}

/** Detect the best connection method for an email address. */
export async function detectMailProvider(email: string, opts: { resolveMx?: MxResolver } = {}): Promise<DetectedProvider> {
  const domain = email.split("@")[1]?.toLowerCase().trim() ?? "";
  if (!domain) return smtpFallback("");

  if (FREE_GOOGLE.has(domain)) {
    return { kind: "google", method: "google_app_password", smtp: GMAIL_SMTP, imap: GMAIL_IMAP, note: "Gmail — generate an app password (2FA required), or connect with Google." };
  }
  if (FREE_MICROSOFT.has(domain)) {
    return { kind: "microsoft", method: "microsoft_oauth", note: "Outlook — connect with Microsoft (basic-auth SMTP is no longer supported)." };
  }
  if (SMTP_PRESETS[domain]) {
    const p = SMTP_PRESETS[domain]!;
    return { kind: "smtp", method: "smtp", smtp: p.smtp, imap: p.imap, note: "Enter your mailbox password to connect." };
  }

  let mxHosts: string[] = [];
  try {
    const mx = await (opts.resolveMx ?? defaultResolveMx)(domain);
    mxHosts = mx.map((m) => m.exchange.toLowerCase());
  } catch {
    mxHosts = [];
  }

  if (mxHosts.some((h) => /google/.test(h))) {
    return { kind: "google", method: "google_app_password", smtp: GMAIL_SMTP, imap: GMAIL_IMAP, note: "Google Workspace — generate an app password, or connect with Google." };
  }
  if (mxHosts.some((h) => /outlook|office365|microsoft/.test(h))) {
    return { kind: "microsoft", method: "microsoft_oauth", note: "Microsoft 365 — connect with Microsoft." };
  }
  return smtpFallback(domain);
}
