import { randomBytes } from "node:crypto";
import { newId } from "@affiliate/core";
import type { Merchant, MerchantUser, User } from "@affiliate/db";
import type { AppContext } from "../context.js";
import { writeAudit } from "./audit.js";

export interface NewMerchantInput {
  merchantName: string;
  niche?: string | null;
  /** ISO-4217, e.g. "MYR". Default "USD". */
  defaultCurrency?: string;
  physicalAddress?: string | null;
  owner: {
    email: string;
    name: string;
    /** A scrypt hash, or "" for an account that will set its password through an invite. */
    passwordHash: string;
  };
  /** "active" for self-signup; "invited" when the owner accepts through a single-use invite link. */
  ownerStatus: "active" | "invited";
}

/**
 * Create a merchant with its owner, owner membership and trial subscription — the one place
 * both self-signup and the `create-owner` command go through, so the two cannot drift.
 */
export async function createMerchantWithOwner(
  ctx: AppContext,
  input: NewMerchantInput,
): Promise<{ user: User; merchant: Merchant; membership: MerchantUser }> {
  const now = ctx.clock.now().toISOString();
  const user = await ctx.db.users.insert({
    id: newId("usr"),
    email: input.owner.email,
    name: input.owner.name,
    passwordHash: input.owner.passwordHash,
    createdAt: now,
  });

  const merchant = await ctx.db.merchants.insert({
    id: newId("mer"),
    name: input.merchantName,
    status: "trial",
    niche: input.niche ?? null,
    competitors: [],
    billingStatus: "trialing",
    defaultCurrency: (input.defaultCurrency ?? "USD").toUpperCase(),
    postbackSecret: `whsec_${randomBytes(24).toString("hex")}`,
    physicalAddress: input.physicalAddress ?? null,
    createdAt: now,
  });

  const membership = await ctx.db.merchantUsers.insert({
    id: newId("mu"),
    merchantId: merchant.id,
    userId: user.id,
    email: user.email,
    name: user.name,
    role: "owner",
    status: input.ownerStatus,
  });

  await ctx.db.subscriptions.insert({
    id: newId("sub"),
    merchantId: merchant.id,
    plan: "track_export",
    status: "trialing",
    trialEndsAt: new Date(ctx.clock.now().getTime() + 14 * 86_400_000).toISOString(),
    renewsAt: null,
  });

  await writeAudit(ctx, { merchantId: merchant.id, actorId: user.id, action: "merchant.created", subjectType: "merchant", subjectId: merchant.id });
  return { user, merchant, membership };
}
