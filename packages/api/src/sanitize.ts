import type { Merchant, User } from "@affiliate/db";

/**
 * Response sanitizers — secrets must never leave the server in a general read.
 * `passwordHash` and the per-merchant `postbackSecret` are stripped from every
 * entity returned to a client. The postback secret is revealed only through the
 * dedicated admin-gated endpoint (and on rotation).
 */
export type PublicUser = Omit<User, "passwordHash">;
export type PublicMerchant = Omit<Merchant, "postbackSecret">;

export function publicUser(user: User): PublicUser {
  const { passwordHash, ...rest } = user;
  void passwordHash;
  return rest;
}

export function publicMerchant(merchant: Merchant): PublicMerchant {
  const { postbackSecret, ...rest } = merchant;
  void postbackSecret;
  return rest;
}
