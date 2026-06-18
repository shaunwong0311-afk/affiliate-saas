/**
 * Typed-ish fetch client for the platform API. Stores the auth token + active
 * merchant in localStorage and attaches them to every request. In dev, Vite
 * proxies `/api` → the origin API (Section 11 topology).
 */
const BASE = "/api";

export interface ApiError {
  message: string;
  code?: string;
  status: number;
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

async function request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (merchantId) headers["x-merchant-id"] = merchantId;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err: ApiError = { message: json?.error?.message ?? res.statusText, code: json?.error?.code, status: res.status };
    throw err;
  }
  return (json.data ?? json) as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>("GET", path),
  post: <T = any>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T = any>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T = any>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T = any>(path: string) => request<T>("DELETE", path),
};

// ---- formatting helpers -----------------------------------------------------
export function money(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const v = Math.abs(cents) / 100;
  return `${sign}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export function num(v: number): string {
  return v.toLocaleString();
}

export function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
