import { randomBytes } from "node:crypto";
import type { MerchantUser, User } from "@affiliate/db";
import type { AppContext } from "../context.js";
import { hashPassword, signJwt, verifyJwt } from "./jwt.js";
import { appendOutstanding, hashNonce, loadOutstanding, nowSeconds, saveOutstanding, serializedWith } from "./single-use.js";

/**
 * Team invites — the emailed `{app}/#/accept-invite?token=…` link through which someone
 * invited to a merchant's team joins it.
 *
 * A membership granted by email address is only as good as the proof that the person behind
 * the account owns that inbox. Accepting used to need no proof at all: an invitee's email
 * address was enough to set the password of their pending account, and an address that
 * already had an account (signup verifies nothing, so anyone can register it first) was
 * added as an active member on the spot. Now EVERY invitation is a single-use token mailed to
 * the invited address, and a membership becomes active only when that token is redeemed:
 *  - by a new invitee, together with the password they choose (the only way a password-less
 *    account ever gets one);
 *  - by an existing account, together with a session of that account — the token proves the
 *    inbox, the session proves the account, and one without the other activates nothing.
 *
 * The token is a signed JWT (kind `user_invite`) naming the invited user, their address and
 * the inviting merchant; single-use.ts makes it single-use.
 */
export const TEAM_INVITE_TTL_SECONDS = 7 * 24 * 3600;

/** Unused invites per (invitee, merchant) — a re-send keeps the previous link alive; past it the oldest lapses. */
const MAX_PER_MERCHANT = 3;
/** Upper bound on one invitee's record across all inviting merchants. */
const MAX_PER_INVITEE = 30;
/** Same floor as signup (the route validates it too; this is the last line). */
const MIN_PASSWORD_LENGTH = 8;

export interface TeamInvite {
  token: string;
  /** The link to email: `{app}/#/accept-invite?token=…` (contract with the web app). */
  url: string;
  expiresInSeconds: number;
}

export type AcceptInviteResult =
  | { status: "accepted"; user: User; membership: MerchantUser }
  /** Bad signature, expired, already used, never issued, withdrawn, or the account's address has changed. */
  | { status: "invalid" }
  /** Genuine invite for a NEW account: the caller must send the password they choose. */
  | { status: "password_required" }
  /** Genuine invite for an EXISTING account: the caller must be signed in as that account. */
  | { status: "sign_in_required" };

const recordKey = (userId: string) => `team-invites:${userId}`;
const purposeFor = (merchantId: string) => `team_invite:${merchantId}`;

/** Mint the single-use link inviting `user` to `merchantId`'s team. */
export function mintTeamInvite(ctx: AppContext, user: Pick<User, "id" | "email">, merchantId: string): Promise<TeamInvite> {
  return serializedWith(ctx, recordKey(user.id), async () => {
    const nonce = randomBytes(24).toString("base64url");
    const token = signJwt({ sub: user.id, kind: "user_invite", email: user.email, jti: nonce, mid: merchantId }, ctx.config.jwtSecret, TEAM_INVITE_TTL_SECONDS);
    const exp = verifyJwt(token, ctx.config.jwtSecret)?.exp ?? nowSeconds() + TEAM_INVITE_TTL_SECONDS;

    const outstanding = await loadOutstanding(ctx, recordKey(user.id));
    const next = appendOutstanding(outstanding, { h: hashNonce(nonce), exp, p: purposeFor(merchantId) }, { perPurpose: MAX_PER_MERCHANT, total: MAX_PER_INVITEE });
    await saveOutstanding(ctx, recordKey(user.id), next);

    const appUrl = ctx.config.corsOrigins[0] ?? "http://localhost:5173";
    return { token, url: `${appUrl}/#/accept-invite?token=${token}`, expiresInSeconds: TEAM_INVITE_TTL_SECONDS };
  });
}

/**
 * Redeem an invite token: activate the invited membership — and, for a new account, set its
 * first password — at most once. Nothing is consumed or changed unless every requirement is
 * met, so a caller who still has to choose a password or sign in can simply try again.
 */
export async function acceptTeamInvite(
  ctx: AppContext,
  token: string,
  proof: { password?: string; sessionUserId?: string | null },
): Promise<AcceptInviteResult> {
  const claims = verifyJwt(token, ctx.config.jwtSecret);
  if (!claims || claims.kind !== "user_invite" || typeof claims.jti !== "string" || !claims.jti || typeof claims.mid !== "string" || !claims.mid) {
    return { status: "invalid" };
  }
  const { sub: userId, jti, email, mid: merchantId } = claims;
  return serializedWith(ctx, recordKey(userId), async (): Promise<AcceptInviteResult> => {
    const user = await ctx.db.users.get(userId);
    if (!user) return { status: "invalid" };
    // The invite proves control of the inbox it was SENT to.
    if (typeof email !== "string" || email.toLowerCase() !== user.email.toLowerCase()) return { status: "invalid" };

    const outstanding = await loadOutstanding(ctx, recordKey(userId));
    const hash = hashNonce(jti);
    const purpose = purposeFor(merchantId);
    if (!outstanding.some((invite) => invite.h === hash && invite.p === purpose)) return { status: "invalid" }; // never issued, or already used

    // The invitation must still stand: an admin withdraws it by disabling the membership.
    const membership = await ctx.db.merchantUsers.findOne((m) => m.merchantId === merchantId && m.userId === userId);
    if (!membership || membership.status !== "invited") return { status: "invalid" };

    const isNewAccount = user.passwordHash === "";
    if (isNewAccount && (!proof.password || proof.password.length < MIN_PASSWORD_LENGTH)) return { status: "password_required" };
    if (!isNewAccount && proof.sessionUserId !== user.id) return { status: "sign_in_required" };

    // Consumed BEFORE anything is granted: this merchant's invites for this person are finished.
    await saveOutstanding(ctx, recordKey(userId), outstanding.filter((invite) => invite.p !== purpose));
    const account = isNewAccount ? await ctx.db.users.update(userId, { passwordHash: hashPassword(proof.password!) }) : user;
    const activated = await ctx.db.merchantUsers.update(membership.id, { status: "active" });
    return { status: "accepted", user: account, membership: activated };
  });
}
