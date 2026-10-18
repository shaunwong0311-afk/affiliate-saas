import { pathToFileURL } from "node:url";
import { createDatabaseFromEnv } from "@affiliate/db";
import { createContext, type AppContext } from "../context.js";
import { mintTeamInvite } from "../auth/invite.js";
import { createMerchantWithOwner } from "../services/merchant-setup.js";

/**
 * Create the first merchant on an install where public signup is closed (production default):
 *
 *   npm run create-owner -- --merchant "Perfect Design" --email owner@example.com \
 *     [--name "Owner Name"] [--currency MYR] [--niche "websites for SMEs"] [--address "…"]
 *
 * The owner account is created WITHOUT a password and the command prints a single-use invite
 * link (`{CORS_ORIGINS[0]}/#/accept-invite?token=…`, valid 7 days); opening it sets the password.
 * Run it with the same environment as the API (DATABASE_URL, JWT_SECRET, CORS_ORIGINS …).
 */
export interface CreateOwnerArgs {
  merchant: string;
  email: string;
  name?: string;
  currency?: string;
  niche?: string;
  address?: string;
}

export async function createOwner(ctx: AppContext, args: CreateOwnerArgs): Promise<{ merchantId: string; userId: string; inviteUrl: string }> {
  const email = args.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`not an email address: ${args.email}`);
  if (!args.merchant.trim()) throw new Error("--merchant is required");
  const currency = (args.currency ?? "USD").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`--currency must be a 3-letter ISO code, got "${args.currency}"`);
  if (await ctx.db.users.findOne((u) => u.email.toLowerCase() === email)) {
    throw new Error(`a user with ${email} already exists — invite them from Settings → Team instead`);
  }
  const { user, merchant } = await createMerchantWithOwner(ctx, {
    merchantName: args.merchant.trim(),
    niche: args.niche?.trim() || null,
    defaultCurrency: currency,
    physicalAddress: args.address?.trim() || null,
    owner: { email, name: args.name?.trim() || email.split("@")[0]!, passwordHash: "" },
    ownerStatus: "invited",
  });
  const invite = await mintTeamInvite(ctx, user, merchant.id);
  return { merchantId: merchant.id, userId: user.id, inviteUrl: invite.url };
}

function parseArgs(argv: string[]): CreateOwnerArgs {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${key}`);
    out[key.slice(2)] = value;
    i++;
  }
  if (!out.merchant || !out.email) throw new Error('usage: create-owner --merchant "Name" --email owner@example.com [--name …] [--currency MYR] [--niche …] [--address …]');
  return { merchant: out.merchant, email: out.email, name: out.name, currency: out.currency, niche: out.niche, address: out.address };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = await createDatabaseFromEnv();
  try {
    const ctx = createContext({ db });
    const result = await createOwner(ctx, args);
    // eslint-disable-next-line no-console
    console.log(`merchant ${result.merchantId} created for ${args.merchant}\nowner invite (single use, 7 days):\n${result.inviteUrl}`);
  } finally {
    await db.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(String((err as Error)?.message ?? err));
    process.exit(1);
  });
}
