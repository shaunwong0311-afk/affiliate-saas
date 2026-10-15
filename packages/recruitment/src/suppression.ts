import { newId } from "@affiliate/core";
import type { Suppression } from "@affiliate/db";
import type { RecruitmentDeps } from "./deps.js";

/**
 * Global + per-merchant suppression (Section 8.9). One-click unsubscribe is
 * honored across ALL merchants — a hard compliance requirement. Bounces and
 * complaints feed suppression too. Checked before every send.
 *
 * Who may suppress for everyone: only the SYSTEM paths (the signed unsubscribe link, a STOP
 * reply, bounce/complaint handling — everything that goes through `suppress()`). A tenant
 * decides for its own outreach only; a row a tenant created never applies to anyone else,
 * even one stored with `scope: "global"` before the API stopped accepting that.
 *
 * And a system path only suppresses for everyone when it is reacting to mail that was really
 * sent: an operator can paste any text as a "reply" for any address they imported, so
 * `suppress()` grants platform-wide scope only if the merchant has a delivered outreach
 * message to that address. Otherwise the opt-out is recorded for that merchant alone.
 */

/** The `reason` the tenant-facing API writes. Also how rows older than `origin` are told apart. */
export const MANUAL_SUPPRESSION_REASON = "manual";

/** True when the row applies to every merchant: global scope AND created by a system path. */
export function appliesGlobally(s: Pick<Suppression, "scope" | "origin" | "reason">): boolean {
  if (s.scope !== "global") return false;
  const origin = s.origin ?? (s.reason === MANUAL_SUPPRESSION_REASON ? "merchant" : "system");
  return origin === "system";
}

/** True when the row applies to `merchantId`'s outreach (its own rows, or a platform-wide one). */
function appliesTo(s: Suppression, merchantId: string): boolean {
  return s.merchantId === merchantId || appliesGlobally(s);
}

function matches(s: Suppression, email: string, domain: string): boolean {
  return Boolean((s.email && s.email.toLowerCase() === email) || (s.domain && s.domain.toLowerCase() === domain));
}

export async function isSuppressed(deps: RecruitmentDeps, merchantId: string, email: string): Promise<boolean> {
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1] ?? "";
  const hit = await deps.db.suppressions.findOne((s) => appliesTo(s, merchantId) && matches(s, lower, domain));
  return !!hit;
}

/**
 * Record a suppression from a SYSTEM path (bounce, complaint, STOP reply).
 *
 * `scope: "global"` is a request, not a guarantee: it is granted only when `merchantId` has
 * actually emailed `email` (see `hasEmailed`). A reply an operator typed in for an address
 * they never mailed — or a whole domain — is recorded with merchant scope: still honoured
 * for the merchant that received it, never a way to silence the address for every tenant.
 */
export async function suppress(
  deps: RecruitmentDeps,
  params: { merchantId: string | null; email?: string; domain?: string; reason: string; scope: "global" | "merchant" },
): Promise<void> {
  if (params.scope === "global" && !params.merchantId) {
    // Without a merchant there is nothing to verify against, and a downgraded row would bind nobody.
    throw new Error("a platform-wide suppression must name the merchant whose mail it answers");
  }
  const scope = params.scope === "global" && !(await hasEmailed(deps, params.merchantId, params.email)) ? "merchant" : params.scope;
  await deps.db.suppressions.insert({
    id: newId("supp"),
    merchantId: params.merchantId,
    email: params.email ?? null,
    domain: params.domain ?? null,
    reason: params.reason,
    scope,
    origin: "system",
    ts: deps.clock.now().toISOString(),
  });
}

/** True when `merchantId` has a delivered outreach message to a prospect with this address. */
async function hasEmailed(deps: RecruitmentDeps, merchantId: string | null, email: string | undefined): Promise<boolean> {
  if (!merchantId || !email) return false;
  const lower = email.toLowerCase();
  const prospects = await deps.db.prospects.find((p) => p.merchantId === merchantId && p.email?.toLowerCase() === lower);
  if (prospects.length === 0) return false;
  const ids = new Set(prospects.map((p) => p.id));
  const delivered = await deps.db.outreachMessages.findOne(
    (m) => ids.has(m.prospectId) && m.sentAt !== null && (m.status === "sent" || m.status === "replied"),
  );
  return delivered !== null;
}

/**
 * Everything that currently stops `merchantId` from emailing someone — what its suppression
 * list has to show, or a blocked send is unexplainable:
 *  - its own rows (added by hand, bounces, and unsubscribes that came through its mail);
 *  - platform-wide rows that hit one of ITS prospects. Those are returned without the
 *    originating merchant, and unrelated platform rows are not returned at all — the global
 *    list is other tenants' unsubscribers and must not be enumerable.
 */
export async function suppressionsAffecting(deps: RecruitmentDeps, merchantId: string): Promise<Suppression[]> {
  const rows = await deps.db.suppressions.find((s) => appliesTo(s, merchantId));
  if (rows.every((s) => s.merchantId === merchantId)) return rows;

  const prospects = await deps.db.prospects.find((p) => p.merchantId === merchantId && !!p.email);
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const p of prospects) {
    const email = p.email!.toLowerCase();
    emails.add(email);
    domains.add(email.split("@")[1] ?? "");
  }
  const out: Suppression[] = [];
  for (const s of rows) {
    if (s.merchantId === merchantId) out.push(s);
    else if ((s.email && emails.has(s.email.toLowerCase())) || (s.domain && domains.has(s.domain.toLowerCase()))) {
      out.push({ ...s, merchantId: null });
    }
  }
  return out;
}
