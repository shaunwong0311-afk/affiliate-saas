/**
 * Turning parsed CSV rows into the two bulk-import payloads. Pure (no DOM, no fetch) so
 * the rules can be exercised in isolation.
 *
 *   POST /recruitment/prospects/import   { source?, rows: [{ name, email?, siteUrl?, channelUrl?, notes? }] }
 *   POST /recruitment/affiliates/import  { rows: [{ name, email, siteUrl?, producedRevenueCents? }] }
 *
 * Both routes validate the WHOLE body with zod and answer 400 if any one row is bad, so a
 * single typo would otherwise reject a 2,000-row file. Rows are therefore checked here
 * against the same rules first: a bad row is excluded (and shown, with the reason), never
 * sent. Nothing is invented — a row without the data it needs is left out, not patched up.
 */
import { parseAmountToCents } from "./amounts";

export type ImportKind = "prospects" | "roster";

export interface ProspectRow {
  name: string;
  email?: string;
  siteUrl?: string;
  channelUrl?: string;
  notes?: string;
}

export interface RosterRow {
  name: string;
  email: string;
  siteUrl?: string;
  producedRevenueCents?: number;
}

export interface FieldSpec {
  key: string;
  label: string;
  /** Header names (normalised: lowercase, letters and digits only) that map to this field. */
  aliases: string[];
}

export const PROSPECT_FIELDS: FieldSpec[] = [
  { key: "name", label: "Name", aliases: ["name", "fullname", "creator", "creatorname", "identity", "contact", "contactname", "affiliate", "affiliatename", "partner", "partnername", "influencer", "company", "brand", "handle", "username"] },
  { key: "email", label: "Email", aliases: ["email", "emailaddress", "mail", "contactemail", "primaryemail", "workemail"] },
  { key: "siteUrl", label: "Website", aliases: ["siteurl", "site", "website", "websiteurl", "web", "url", "domain", "blog", "blogurl", "homepage"] },
  { key: "channelUrl", label: "Channel / social URL", aliases: ["channelurl", "channel", "social", "socialurl", "sociallink", "profile", "profileurl", "youtube", "youtubeurl", "instagram", "instagramurl", "tiktok", "tiktokurl", "twitter", "x", "linkedin", "substack", "podcast"] },
  { key: "notes", label: "Notes", aliases: ["notes", "note", "comment", "comments", "description", "context", "memo"] },
];

export const ROSTER_FIELDS: FieldSpec[] = [
  { key: "name", label: "Name", aliases: ["name", "fullname", "affiliate", "affiliatename", "partner", "partnername", "creator", "contact", "contactname", "company"] },
  { key: "email", label: "Email", aliases: ["email", "emailaddress", "mail", "contactemail", "primaryemail", "paypalemail"] },
  { key: "siteUrl", label: "Website", aliases: ["siteurl", "site", "website", "websiteurl", "web", "url", "domain", "blog", "channel", "channelurl"] },
  { key: "revenue", label: "Revenue produced (amount, e.g. 1250.00)", aliases: ["revenue", "producedrevenue", "revenueproduced", "sales", "totalsales", "totalrevenue", "lifetimerevenue", "lifetimesales", "grosssales", "netsales"] },
  { key: "revenueCents", label: "Revenue produced (cents)", aliases: ["producedrevenuecents", "revenuecents", "salescents"] },
];

export function fieldsFor(kind: ImportKind): FieldSpec[] {
  return kind === "prospects" ? PROSPECT_FIELDS : ROSTER_FIELDS;
}

/** The header row a blank template should carry (headers only — no sample people). */
export function templateHeader(kind: ImportKind): string {
  return kind === "prospects" ? "name,email,siteUrl,channelUrl,notes" : "name,email,siteUrl,revenue";
}

export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Column index → field key ("" = ignore). Each field is claimed by the first column that names it. */
export function guessMapping(headerCells: string[], fields: FieldSpec[]): string[] {
  const taken = new Set<string>();
  return headerCells.map((cell) => {
    const normalized = normalizeHeader(cell);
    if (!normalized) return "";
    const field = fields.find((f) => !taken.has(f.key) && f.aliases.includes(normalized));
    if (!field) return "";
    taken.add(field.key);
    return field.key;
  });
}

/**
 * Is the first row a header? Yes when at least one cell names a known field and no cell
 * looks like data (an email address or a URL) — so a headerless list of people is not
 * mistaken for a header just because someone is called "Brand".
 */
export function looksLikeHeader(firstRow: string[], fields: FieldSpec[]): boolean {
  if (firstRow.some((cell) => looksLikeEmail(cell) || /^https?:\/\//i.test(cell))) return false;
  return guessMapping(firstRow, fields).some((key) => key !== "");
}

/** Mapping for a file with no header row: the documented column order. */
export function positionalMapping(columnCount: number, kind: ImportKind): string[] {
  const order = kind === "prospects" ? ["name", "email", "siteUrl", "channelUrl", "notes"] : ["name", "email", "siteUrl", "revenue"];
  return Array.from({ length: columnCount }, (_, i) => order[i] ?? "");
}

// ---- value cleaning ---------------------------------------------------------

// The exact pattern zod 3.x uses for `.email()`, so a row that passes here passes the API.
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** "Jamie <jamie@x.com>" / "mailto:jamie@x.com" → "jamie@x.com"; null when not an address. */
export function cleanEmail(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  const angled = /<([^<>\s]+)>/.exec(s);
  if (angled) s = angled[1]!;
  s = s.replace(/^mailto:/i, "").trim();
  return EMAIL_RE.test(s) ? s : null;
}

/**
 * A web address to http(s) form: "example.com/blog" → "https://example.com/blog".
 * Returns null for anything that is not a public-looking web URL (other schemes, a bare
 * @handle, a hostname with no dot).
 */
export function cleanUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(s);
  if (hasScheme && !/^https?:\/\//i.test(s)) return null;
  const candidate = hasScheme ? s : `https://${s.replace(/^\/+/, "")}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname;
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return null;
  // A creator's site is a named host. Refuse address literals and credentials outright:
  // the server fetches these URLs, and neither belongs in an import file.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return null;
  if (url.username || url.password) return null;
  return candidate;
}

const MAX_NAME = 200;
const MAX_NOTES = 2000;

// ---- row preparation --------------------------------------------------------

export interface RowIssue {
  /** "error" = the row is excluded; "warn" = the row is sent, minus the bad value. */
  level: "error" | "warn";
  message: string;
}

export interface PreparedRow<T> {
  /** 1-based line in the pasted/uploaded data (the header row counts as line 1). */
  line: number;
  /** null = excluded from the upload. */
  value: T | null;
  issues: RowIssue[];
}

function cellFor(row: string[], mapping: string[], key: string): string {
  const index = mapping.indexOf(key);
  return index === -1 ? "" : (row[index] ?? "").trim();
}

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

export function prepareProspectRows(rows: string[][], mapping: string[], firstLine: number): PreparedRow<ProspectRow>[] {
  const seen = new Map<string, number>();
  return rows.map((row, i) => {
    const line = firstLine + i;
    const issues: RowIssue[] = [];
    const name = cleanName(cellFor(row, mapping, "name"));

    const rawEmail = cellFor(row, mapping, "email");
    const email = rawEmail ? cleanEmail(rawEmail) : null;
    if (rawEmail && !email) issues.push({ level: "warn", message: `"${rawEmail}" is not an email address — left out` });

    const rawSite = cellFor(row, mapping, "siteUrl");
    const siteUrl = rawSite ? cleanUrl(rawSite) : null;
    if (rawSite && !siteUrl) issues.push({ level: "warn", message: `"${rawSite}" is not a web address — left out` });

    const rawChannel = cellFor(row, mapping, "channelUrl");
    const channelUrl = rawChannel ? cleanUrl(rawChannel) : null;
    if (rawChannel && !channelUrl) issues.push({ level: "warn", message: `"${rawChannel}" is not a web address — left out` });

    const rawNotes = cellFor(row, mapping, "notes");
    const notes = rawNotes.slice(0, MAX_NOTES);
    if (rawNotes.length > MAX_NOTES) issues.push({ level: "warn", message: `notes shortened to ${MAX_NOTES} characters` });

    if (!name) issues.push({ level: "error", message: "no name" });
    // The API skips a row it cannot identify; say so here instead of after the upload.
    if (!email && !siteUrl && !channelUrl) issues.push({ level: "error", message: "needs an email, a website or a channel URL" });

    if (issues.some((x) => x.level === "error")) return { line, value: null, issues };

    const key = [name.toLowerCase(), email?.toLowerCase() ?? "", siteUrl ?? "", channelUrl ?? ""].join("\u0001");
    const first = seen.get(key);
    if (first !== undefined) return { line, value: null, issues: [...issues, { level: "error", message: `same as line ${first}` }] };
    seen.set(key, line);

    const value: ProspectRow = { name };
    if (email) value.email = email;
    if (siteUrl) value.siteUrl = siteUrl;
    if (channelUrl) value.channelUrl = channelUrl;
    if (notes) value.notes = notes;
    return { line, value, issues };
  });
}

export function prepareRosterRows(rows: string[][], mapping: string[], firstLine: number): PreparedRow<RosterRow>[] {
  const seen = new Map<string, number>();
  return rows.map((row, i) => {
    const line = firstLine + i;
    const issues: RowIssue[] = [];
    const name = cleanName(cellFor(row, mapping, "name"));
    const rawEmail = cellFor(row, mapping, "email");
    const email = rawEmail ? cleanEmail(rawEmail) : null;

    const rawSite = cellFor(row, mapping, "siteUrl");
    const siteUrl = rawSite ? cleanUrl(rawSite) : null;
    if (rawSite && !siteUrl) issues.push({ level: "warn", message: `"${rawSite}" is not a web address — left out` });

    // Revenue: either a currency amount or integer cents, whichever column is mapped.
    let producedRevenueCents: number | null = null;
    const rawCents = cellFor(row, mapping, "revenueCents");
    const rawAmount = cellFor(row, mapping, "revenue");
    if (rawCents) {
      const n = Number(rawCents.replace(/[,\s]/g, ""));
      if (Number.isSafeInteger(n) && n >= 0) producedRevenueCents = n;
      else issues.push({ level: "warn", message: `"${rawCents}" is not a whole number of cents — revenue left out` });
    } else if (rawAmount) {
      const cents = parseAmountToCents(rawAmount);
      if (cents !== null && cents >= 0) producedRevenueCents = cents;
      else issues.push({ level: "warn", message: `"${rawAmount}" is not a positive amount — revenue left out` });
    }

    if (!name) issues.push({ level: "error", message: "no name" });
    if (!rawEmail) issues.push({ level: "error", message: "no email" });
    else if (!email) issues.push({ level: "error", message: `"${rawEmail}" is not an email address` });

    if (!email || issues.some((x) => x.level === "error")) return { line, value: null, issues };

    const key = email.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) return { line, value: null, issues: [...issues, { level: "error", message: `same email as line ${first}` }] };
    seen.set(key, line);

    const value: RosterRow = { name, email };
    if (siteUrl) value.siteUrl = siteUrl;
    if (producedRevenueCents !== null && producedRevenueCents > 0) value.producedRevenueCents = producedRevenueCents;
    return { line, value, issues };
  });
}

// ---- upload batching --------------------------------------------------------

/** The API caps a request body at 1 MB and a batch at 5,000 rows; stay well inside both. */
export const MAX_BATCH_ROWS = 500;
export const MAX_BATCH_BYTES = 600_000;

function jsonBytes(value: unknown): number {
  // UTF-8 length without TextEncoder so this stays environment-neutral.
  const s = JSON.stringify(value);
  let bytes = s.length;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 0x7f) bytes += code > 0x7ff ? 2 : 1;
  }
  return bytes;
}

/** Split rows into batches that respect both the row and the byte ceiling. */
export function batchRows<T>(rows: T[], maxRows = MAX_BATCH_ROWS, maxBytes = MAX_BATCH_BYTES): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const row of rows) {
    const bytes = jsonBytes(row) + 1;
    if (current.length > 0 && (current.length >= maxRows || size + bytes > maxBytes)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Row-level failures from the API's validation message, e.g.
 * `validation: rows.3.email Invalid email; rows.7.name String must contain at least 1 character(s)`.
 * Returns batch-relative index → reason. Empty when the error is not about specific rows.
 */
export function parseRowErrors(message: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = /rows\.(\d+)(?:\.([A-Za-z0-9_]+))?\s+([^;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const index = Number(m[1]);
    const reason = `${m[2] ? `${m[2]}: ` : ""}${m[3]!.trim()}`;
    out.set(index, out.has(index) ? `${out.get(index)}; ${reason}` : reason);
  }
  return out;
}

// ---- upload -----------------------------------------------------------------

/** A row that passed the preview, with its line in the file. */
export interface ReadyRow<T> {
  line: number;
  value: T;
}

export interface UploadSummary {
  /** Rows in requests the API accepted. */
  accepted: number;
  /** The API's own counters, summed across batches (imported/merged/skipped, created/existing/skipped, …). */
  counts: Record<string, number>;
  /** Rows the API refused by name, mapped back to their line in the file. */
  refused: { line: number; reason: string }[];
}

export type UploadOutcome<T> =
  | { status: "finished"; summary: UploadSummary }
  /** A batch failed for a reason that is not about specific rows. `remaining` was not sent. */
  | { status: "stopped"; summary: UploadSummary; error: unknown; remaining: ReadyRow<T>[] };

export function emptyUploadSummary(): UploadSummary {
  return { accepted: 0, counts: {}, refused: [] };
}

/** Add every numeric counter in an API response to the running totals. */
function addCounts(totals: Record<string, number>, response: unknown): void {
  if (!response || typeof response !== "object" || Array.isArray(response)) return;
  for (const [key, value] of Object.entries(response as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
  }
}

/** How many times one batch is re-sent after the API names bad rows in it. */
const MAX_ROW_RETRIES = 3;

/**
 * Send rows in batches. `send` posts ONE batch and resolves with the API's response body.
 *
 * The API validates a whole request at once, so a single row it dislikes fails the batch
 * with HTTP 400 and a message naming the row ("rows.12.email Invalid email"). Such rows
 * are recorded against their line in the file and dropped, and the rest of the batch is
 * sent again. Any other failure stops the upload and hands back what was not sent, so the
 * caller can resume from there. Never throws.
 */
export async function uploadRows<T>(opts: {
  rows: ReadyRow<T>[];
  send: (batch: T[]) => Promise<unknown>;
  /** Totals so far, when resuming a stopped upload. */
  base?: UploadSummary;
  onProgress?: (done: number, total: number) => void;
  maxRows?: number;
  maxBytes?: number;
}): Promise<UploadOutcome<T>> {
  const base = opts.base ?? emptyUploadSummary();
  const summary: UploadSummary = { accepted: base.accepted, counts: { ...base.counts }, refused: [...base.refused] };
  const total = opts.rows.length;
  const batches = batchRows(opts.rows, opts.maxRows, opts.maxBytes);
  let done = 0;
  opts.onProgress?.(done, total);

  for (let b = 0; b < batches.length; b++) {
    let pending = batches[b]!;
    for (let attempt = 0; pending.length > 0; attempt++) {
      try {
        addCounts(summary.counts, await opts.send(pending.map((r) => r.value)));
        summary.accepted += pending.length;
        break;
      } catch (e) {
        const status = (e as { status?: unknown } | null)?.status;
        const message = (e as { message?: unknown } | null)?.message;
        const rowErrors = status === 400 && typeof message === "string" ? parseRowErrors(message) : new Map<number, string>();
        // Only indexes that exist in THIS batch count — anything else is not a row error we can act on.
        const named = [...rowErrors.keys()].filter((i) => i >= 0 && i < pending.length);
        if (named.length === 0 || attempt >= MAX_ROW_RETRIES) {
          return { status: "stopped", summary, error: e, remaining: [...pending, ...batches.slice(b + 1).flat()] };
        }
        const keep: ReadyRow<T>[] = [];
        pending.forEach((row, i) => {
          const reason = rowErrors.get(i);
          if (reason !== undefined) summary.refused.push({ line: row.line, reason });
          else keep.push(row);
        });
        pending = keep;
      }
    }
    done += batches[b]!.length;
    opts.onProgress?.(done, total);
  }
  return { status: "finished", summary };
}
