import { randomBytes } from "node:crypto";
import type { Affiliate } from "@affiliate/db";
import type { AppContext } from "../context.js";
import { signJwt, verifyJwt } from "./jwt.js";
import { appendOutstanding, hashNonce, loadOutstanding, nowSeconds, saveOutstanding, serialized } from "./single-use.js";

/**
 * Affiliate magic links (emailed `{app}/#/portal/verify?token=…`) — SINGLE-USE.
 *
 * The token is a signed JWT (kind `affiliate_magic`) carrying a random nonce; single-use.ts
 * records it per affiliate at mint and removes it at redemption, so the same token cannot be
 * exchanged for a session twice. Several links may be outstanding at once — a welcome email
 * from each of two merchants plus a sign-in link must all work, once each.
 */

export interface MagicLink {
  token: string;
  /** The link to email: `{app}/#/portal/verify?token=…` (contract with the web app). */
  url: string;
  expiresInSeconds: number;
}

/** Sign-in links are requested from a public form, so they are short-lived. */
export const SIGN_IN_LINK_TTL_SECONDS = 15 * 60;

/**
 * Unused links one affiliate may hold. Sign-in links are requested by anyone who knows the
 * address, so at the cap no new one is issued (and no email sent) until one is used or
 * expires — links already delivered stay valid, and the affiliate cannot be mail-bombed.
 * Activation links are issued by merchants' actions and counted PER MERCHANT: past its cap a
 * merchant's own oldest link lapses, so one merchant can never push out another's welcome link.
 */
const MAX_SIGN_IN = 5;
const MAX_ACTIVATION_PER_MERCHANT = 3;
const MAX_ACTIVATION_UNSCOPED = 10;
/** Upper bound on one affiliate's record across every purpose. */
const MAX_PER_AFFILIATE = 40;

type AffiliateRef = Pick<Affiliate, "id" | "primaryEmail">;

const recordKey = (affiliateId: string) => `affiliate-magic-links:${affiliateId}`;

/**
 * Mint the sign-in link an affiliate asked for. Returns null when they already hold the
 * maximum number of unused sign-in links — the caller must then send nothing.
 */
export function mintSignInMagicLink(ctx: AppContext, affiliate: AffiliateRef): Promise<MagicLink | null> {
  return mint(ctx, affiliate, "signin", SIGN_IN_LINK_TTL_SECONDS, MAX_SIGN_IN, "refuse");
}

/**
 * Mint the one-click link for an activation (welcome) email. Always returns a link; it is
 * single-use like every other, and the portal offers "send me a new link" once it is spent.
 * Pass the merchant the welcome is for so its links are capped separately from other merchants'.
 */
export async function mintActivationMagicLink(ctx: AppContext, affiliate: AffiliateRef, ttlSeconds: number, merchantId?: string): Promise<MagicLink> {
  const link = merchantId
    ? await mint(ctx, affiliate, `activation:${merchantId}`, ttlSeconds, MAX_ACTIVATION_PER_MERCHANT, "drop-oldest")
    : await mint(ctx, affiliate, "activation", ttlSeconds, MAX_ACTIVATION_UNSCOPED, "drop-oldest");
  return link!;
}

/**
 * Exchange a magic-link token for the affiliate it signs in — at most once. Null for every
 * failure (bad signature, expired, already used, unknown affiliate, address since changed).
 * The link is consumed BEFORE the caller can issue a session.
 */
export async function redeemMagicLinkToken(ctx: AppContext, token: string): Promise<Affiliate | null> {
  const claims = verifyJwt(token, ctx.config.jwtSecret);
  if (!claims || claims.kind !== "affiliate_magic" || typeof claims.jti !== "string" || !claims.jti) return null;
  const { sub: affiliateId, jti, email } = claims;
  return serialized(recordKey(affiliateId), async () => {
    const affiliate = await ctx.db.affiliates.get(affiliateId);
    if (!affiliate) return null;
    // The link proves control of the inbox it was SENT to, not of whatever address is on file now.
    if (typeof email !== "string" || email.toLowerCase() !== affiliate.primaryEmail.toLowerCase()) return null;

    const outstanding = await loadOutstanding(ctx, recordKey(affiliate.id));
    const hash = hashNonce(jti);
    const remaining = outstanding.filter((link) => link.h !== hash);
    if (remaining.length === outstanding.length) return null; // never issued, or already used
    await saveOutstanding(ctx, recordKey(affiliate.id), remaining);
    return affiliate;
  });
}

function mint(
  ctx: AppContext,
  affiliate: AffiliateRef,
  purpose: string,
  ttlSeconds: number,
  max: number,
  whenFull: "refuse" | "drop-oldest",
): Promise<MagicLink | null> {
  return serialized(recordKey(affiliate.id), async () => {
    const outstanding = await loadOutstanding(ctx, recordKey(affiliate.id));
    if (whenFull === "refuse" && outstanding.filter((link) => link.p === purpose).length >= max) return null;

    const nonce = randomBytes(24).toString("base64url");
    const token = signJwt({ sub: affiliate.id, kind: "affiliate_magic", email: affiliate.primaryEmail, jti: nonce }, ctx.config.jwtSecret, ttlSeconds);
    const exp = verifyJwt(token, ctx.config.jwtSecret)?.exp ?? nowSeconds() + ttlSeconds;
    await saveOutstanding(
      ctx,
      recordKey(affiliate.id),
      appendOutstanding(outstanding, { h: hashNonce(nonce), exp, p: purpose }, { perPurpose: max, total: MAX_PER_AFFILIATE }),
    );

    const appUrl = ctx.config.corsOrigins[0] ?? "http://localhost:5173";
    return { token, url: `${appUrl}/#/portal/verify?token=${token}`, expiresInSeconds: ttlSeconds };
  });
}
