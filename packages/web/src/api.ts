/**
 * Typed-ish fetch client for the platform API. Stores the auth token + active
 * merchant in localStorage and attaches them to every request. In dev, Vite
 * proxies `/api` → the origin API (Section 11 topology).
 */
import { filenameFromDisposition, saveBlob } from "./download";

// Configurable at build time. Dev uses the Vite proxy ("/api"); a Cloudflare
// Pages / static deploy sets VITE_API_BASE to the API origin (e.g. https://api.you.com).
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

/**
 * Every failed request rejects with one of these. `status` is the HTTP status, or 0 when
 * the request never got an answer (offline, DNS, CORS, the API is down).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** The HTTP status of a caught error, or null when it is not an API error. */
export function errorStatus(e: unknown): number | null {
  const status = (e as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : null;
}

/** A displayable message for anything a request can throw. */
export function errorMessage(e: unknown, fallback = "request failed"): string {
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message ? message : fallback;
}

let token: string | null = localStorage.getItem("vantage_token");
let merchantId: string | null = localStorage.getItem("vantage_merchant");

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem("vantage_token", t);
  else localStorage.removeItem("vantage_token");
}

export function setMerchant(id: string | null): void {
  merchantId = id;
  if (id) localStorage.setItem("vantage_merchant", id);
  else localStorage.removeItem("vantage_merchant");
}

export function getMerchant(): string | null {
  return merchantId;
}

export function hasToken(): boolean {
  return !!token;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (merchantId) headers["x-merchant-id"] = merchantId;
  return headers;
}

async function send(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch only rejects when no response arrived at all.
    throw new ApiError("Can't reach the server. Check your connection and try again.", 0, "network");
  }
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // not JSON (a proxy error page, an HTML 502, …)
  }
}

/** Build the error for a non-2xx response from the API's `{ error: { message, code } }` envelope. */
function toApiError(res: Response, text: string): ApiError {
  const json = parseJson(text) as { error?: { message?: unknown; code?: unknown } } | undefined;
  const message = typeof json?.error?.message === "string" && json.error.message ? json.error.message : res.statusText || `Request failed (HTTP ${res.status})`;
  const code = typeof json?.error?.code === "string" ? json.error.code : undefined;
  return new ApiError(message, res.status, code);
}

async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(method, path, { ...authHeaders(), "Content-Type": "application/json" }, body);
  const text = await res.text();
  if (!res.ok) throw toApiError(res, text);
  const json = parseJson(text);
  if (json === undefined) throw new ApiError("The server sent a response this app could not read.", res.status, "bad_response");
  // Every route answers `{ data }`; unwrap it (a bare payload passes through untouched).
  if (json !== null && typeof json === "object" && "data" in json) return (json as { data: unknown }).data as T;
  return json as T;
}

export interface DownloadResult {
  filename: string;
  bytes: number;
}

/**
 * Fetch a non-JSON resource (the payout file is `text/csv`) WITH the auth headers and hand
 * it to the browser as a download. A plain `<a href>` cannot do this: the API authenticates
 * by header, not cookie. Errors still arrive as the JSON envelope and become an ApiError.
 */
async function download(path: string, fallbackFilename: string): Promise<DownloadResult> {
  const res = await send("GET", path, { ...authHeaders(), Accept: "text/csv, text/plain;q=0.9, */*;q=0.5" });
  if (!res.ok) throw toApiError(res, await res.text());

  let blob: Blob;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    // Not the contract, but tolerate a JSON-wrapped file ({ data: "<csv>" }) rather than
    // saving an envelope the merchant would then upload to their bank.
    const json = parseJson(await res.text()) as { data?: unknown } | undefined;
    const data = json?.data;
    const inner = typeof data === "string" ? data : typeof (data as { csv?: unknown } | null)?.csv === "string" ? (data as { csv: string }).csv : null;
    if (inner == null) throw new ApiError("The server did not return a file.", res.status, "bad_response");
    blob = new Blob([inner], { type: "text/csv;charset=utf-8" });
  } else {
    blob = await res.blob();
  }
  if (blob.size === 0) throw new ApiError("The file came back empty — there is nothing to export.", res.status, "empty_file");

  // Content-Disposition is only readable cross-origin when the API exposes it; fall back
  // to a name built by the caller.
  const filename = filenameFromDisposition(res.headers.get("content-disposition")) ?? fallbackFilename;
  saveBlob(blob, filename);
  return { filename, bytes: blob.size };
}

export const api = {
  get: <T = any>(path: string) => request<T>("GET", path),
  post: <T = any>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T = any>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T = any>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T = any>(path: string) => request<T>("DELETE", path),
  download,
};

// ---- formatting helpers -----------------------------------------------------
// These are called on API data in render paths, so they never throw: a missing or
// non-numeric value renders as an em dash instead of taking the page down.
type Num = number | null | undefined;

function isNum(v: Num): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function money(cents: Num, currency = "USD"): string {
  if (!isNum(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  const v = Math.abs(cents) / 100;
  return `${sign}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function pct(v: Num): string {
  if (!isNum(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

export function num(v: Num): string {
  if (!isNum(v)) return "—";
  return v.toLocaleString();
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
