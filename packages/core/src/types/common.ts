import type { CurrencyCode } from "../money.js";

export type Id = string;
export type Timestamp = string; // ISO-8601

export type EngineKind = "affiliate" | "mlm";

/** Roles an affiliate opts into per program (Section 7). */
export type AffiliateRole = "seller" | "recruiter" | "both";

export function isSeller(role: AffiliateRole): boolean {
  return role === "seller" || role === "both";
}
export function isRecruiter(role: AffiliateRole): boolean {
  return role === "recruiter" || role === "both";
}

export interface AuditStamp {
  readonly createdAt: Timestamp;
  readonly updatedAt?: Timestamp;
}

export interface Tenanted {
  readonly merchantId: Id;
}

export type { CurrencyCode };
