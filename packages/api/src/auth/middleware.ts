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
    const hashed = hashApiKey(token);
    const key = await ctx.db.apiKeys.findOne((k) => k.hashedKey === hashed && k.revokedAt === null);
    if (!key) return null;
    await ctx.db.apiKeys.update(key.id, { lastUsedAt: ctx.clock.now().toISOString() });
    return { kind: "apikey", apiKeyId: key.id, scopes: key.scopes };
  }

  const claims = verifyJwt(token, ctx.config.jwtSecret);
  if (!claims) return null;
  if (claims.kind === "affiliate") return { kind: "affiliate", affiliateId: claims.sub, email: claims.email };
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

export function requireAffiliate(request: FastifyRequest): string {
  const principal = requirePrincipal(request);
  if (principal.kind !== "affiliate" || !principal.affiliateId) throw forbidden("affiliate principal required");
  return principal.affiliateId;
}
