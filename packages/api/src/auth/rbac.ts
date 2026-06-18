import type { MerchantRole } from "@affiliate/db";

/**
 * Tenant-scoped RBAC (Section 4 cross-cutting). A simple, auditable rank model:
 * higher ranks include the capabilities of lower ones. Route handlers declare a
 * minimum capability; the middleware enforces it against the caller's role on the
 * resolved merchant.
 */
export const ROLE_RANK: Record<MerchantRole, number> = {
  viewer: 1,
  analyst: 2,
  manager: 3,
  admin: 4,
  owner: 5,
};

export type Capability = "read" | "write" | "approve" | "admin" | "owner";

const CAPABILITY_MIN_RANK: Record<Capability, number> = {
  read: ROLE_RANK.viewer,
  write: ROLE_RANK.manager,
  approve: ROLE_RANK.manager, // approving payouts/conversions
  admin: ROLE_RANK.admin, // team, integrations, billing
  owner: ROLE_RANK.owner, // destructive / ownership transfer
};

export function roleAllows(role: MerchantRole, capability: Capability): boolean {
  return ROLE_RANK[role] >= CAPABILITY_MIN_RANK[capability];
}

export class ForbiddenError extends Error {
  statusCode = 403;
  constructor(capability: Capability, role: MerchantRole) {
    super(`role "${role}" lacks capability "${capability}"`);
    this.name = "ForbiddenError";
  }
}
