import type { FastifyRequest } from "fastify";
import type { MerchantRole } from "@affiliate/db";
import type { AppContext } from "../context.js";
import { verifyJwt, hashApiKey } from "./jwt.js";
import { roleAllows, type Capability } from "./rbac.js";
import { unauthorized, forbidden } from "../errors.js";

/** The resolved caller on each request. */
export interface AuthPrincipal {
  kind: "user" | "affiliate" | "apikey";
  userId?: string;
  affiliateId?: string;
  apiKeyId?: string;
  email?: string;
  scopes?: string[];
  /**
   * Set on a support session minted by POST /admin/impersonate/:affiliateId: `userId`, acting
   * for `merchantId`, is viewing the portal as this affiliate. Such a session is READ-ONLY
   * and sees only that merchant's slice of the affiliate's data.
   */
  impersonation?: { merchantId: string; userId: string };
}

export interface MerchantScope {
  merchantId: string;
  role: MerchantRole;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: AuthPrincipal;
    merchantScope?: MerchantScope;
  }
}

/** Resolve the principal from the Authorization header (JWT or API key). */
export async function resolvePrincipal(ctx: AppContext, request: FastifyRequest): Promise<AuthPrincipal | null> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();

  if (token.startsWith("ak_")) {
    const hashed = hashApiKey(token, ctx.config.apiKeyPepper);
    const key = await ctx.db.apiKeys.findOne((k) => k.hashedKey === hashed && k.revokedAt === null);
    if (!key) return null;
    await ctx.db.apiKeys.update(key.id, { lastUsedAt: ctx.clock.now().toISOString() });
    return { kind: "apikey", apiKeyId: key.id, scopes: key.scopes };
  }

  const claims = verifyJwt(token, ctx.config.jwtSecret);
  if (!claims) return null;
  if (claims.kind === "affiliate") {
    if (claims.imp === undefined) return { kind: "affiliate", affiliateId: claims.sub, email: claims.email };
    // A support session must name both the merchant and the user behind it; a token whose
    // `imp` claim is anything else is not a session at all (never an unscoped one).
    const imp = claims.imp as { merchantId?: unknown; userId?: unknown } | null;
    if (!imp || typeof imp.merchantId !== "string" || !imp.merchantId || typeof imp.userId !== "string" || !imp.userId) return null;
    return { kind: "affiliate", affiliateId: claims.sub, email: claims.email, impersonation: { merchantId: imp.merchantId, userId: imp.userId } };
  }
  if (claims.kind === "user") return { kind: "user", userId: claims.sub, email: claims.email };
  // Any other kind (e.g. a single-use magic-link token) is NOT a valid session.
  return null;
}

export function requirePrincipal(request: FastifyRequest): AuthPrincipal {
  if (!request.principal) throw unauthorized();
  return request.principal;
}

/**
 * Resolve and authorize the merchant scope for a request. Merchant id comes from
 * the `x-merchant-id` header or a route `:merchantId` param. Users must have a
 * membership; API keys are bound to their merchant.
 */
export async function requireMerchant(
  ctx: AppContext,
  request: FastifyRequest,
  capability: Capability = "read",
): Promise<MerchantScope> {
  const principal = requirePrincipal(request);
  const params = request.params as Record<string, string> | undefined;
  const headerMerchant = request.headers["x-merchant-id"];
  const merchantId = params?.merchantId ?? (typeof headerMerchant === "string" ? headerMerchant : undefined);

  if (principal.kind === "apikey") {
    const key = await ctx.db.apiKeys.require(principal.apiKeyId!);
    if (merchantId && merchantId !== key.merchantId) throw forbidden("api key not scoped to this merchant");
    const role: MerchantRole = key.scopes.includes("write") ? "manager" : "viewer";
    request.merchantScope = { merchantId: key.merchantId, role };
    if (!roleAllows(role, capability)) throw forbidden("api key scope insufficient");
    return request.merchantScope;
  }

  if (principal.kind !== "user") throw forbidden("merchant scope requires a user principal");
  if (!merchantId) throw forbidden("missing merchant id");
  const membership = await ctx.db.merchantUsers.findOne(
    (m) => m.merchantId === merchantId && m.userId === principal.userId && m.status === "active",
  );
  if (!membership) throw forbidden("not a member of this merchant");
  if (!roleAllows(membership.role, capability)) throw forbidden(`role ${membership.role} lacks ${capability}`);
  request.merchantScope = { merchantId, role: membership.role };
  return request.merchantScope;
}

/**
 * The affiliate acting for THEMSELVES — the guard for anything that changes their account.
 * A support (impersonated) session is refused here: it can only read, and only through
 * `requirePortalScope`, so a route that forgets about impersonation fails closed.
 */
export function requireAffiliate(request: FastifyRequest): string {
  const principal = requirePrincipal(request);
  if (principal.kind !== "affiliate" || !principal.affiliateId) throw forbidden("affiliate principal required");
  if (principal.impersonation) throw forbidden("support (impersonated) sessions are read-only");
  return principal.affiliateId;
}

/** Whose portal data a request may read. */
export interface PortalScope {
  affiliateId: string;
  /** The one merchant a support session may see; null = the affiliate's own session (all of theirs). */
  merchantId: string | null;
}

/** Guard for portal READS: the affiliate themselves, or a support session limited to its merchant. */
export function requirePortalScope(request: FastifyRequest): PortalScope {
  const principal = requirePrincipal(request);
  if (principal.kind !== "affiliate" || !principal.affiliateId) throw forbidden("affiliate principal required");
  return { affiliateId: principal.affiliateId, merchantId: principal.impersonation?.merchantId ?? null };
}
