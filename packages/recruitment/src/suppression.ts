import { newId } from "@affiliate/core";
import type { RecruitmentDeps } from "./deps.js";

/**
 * Global + per-merchant suppression (Section 8.9). One-click unsubscribe is
 * honored across ALL merchants — a hard compliance requirement. Bounces and
 * complaints feed suppression too. Checked before every send.
 */
export async function isSuppressed(deps: RecruitmentDeps, merchantId: string, email: string): Promise<boolean> {
  const lower = email.toLowerCase();
  const domain = lower.split("@")[1] ?? "";
  const hit = await deps.db.suppressions.findOne(
    (s) =>
      (s.scope === "global" || s.merchantId === merchantId) &&
      Boolean((s.email && s.email.toLowerCase() === lower) || (s.domain && s.domain.toLowerCase() === domain)),
  );
  return !!hit;
}

export async function suppress(
  deps: RecruitmentDeps,
  params: { merchantId: string | null; email?: string; domain?: string; reason: string; scope: "global" | "merchant" },
): Promise<void> {
  await deps.db.suppressions.insert({
    id: newId("supp"),
    merchantId: params.merchantId,
    email: params.email ?? null,
    domain: params.domain ?? null,
    reason: params.reason,
    scope: params.scope,
    ts: deps.clock.now().toISOString(),
  });
}
