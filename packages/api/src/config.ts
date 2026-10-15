import { DEV_INSECURE_SECRET, deriveSecret, envSecret, secretWeakness } from "@affiliate/core";

export interface AppConfig {
  jwtSecret: string;
  /** Default commission hold period before funds become payable (Section 7). */
  defaultHoldDays: number;
  /** Default per-merchant minimum payout threshold in cents. */
  defaultMinPayoutCents: number;
  /** Auto-approve conversions below the fraud review score, else queue for review. */
  autoApproveConversions: boolean;
  trackingBaseUrl: string;
  corsOrigins: string[];
  isProduction: boolean;
  /** Outside production, magic-link tokens are returned in the response for dev convenience. */
  exposeMagicLink: boolean;
  /**
   * Whether deterministic/synthetic discovery sources (which fabricate demo
   * prospects) are allowed to run. Default: true outside production, FALSE in
   * production — so a deployed instance never invents affiliates. Can be forced on
   * with ALLOW_SYNTHETIC_DISCOVERY=true (e.g. a sales demo) or off in dev.
   */
  allowSyntheticDiscovery: boolean;
  /** Public base URL of THIS API (for OAuth redirect URIs + magic/unsub links). */
  publicApiUrl: string;
  /** Mailbox-OAuth client credentials (per provider). Absent → that provider's connect is off. */
  oauth: {
    microsoft?: { clientId: string; clientSecret: string };
    google?: { clientId: string; clientSecret: string };
  };
  /** Key for the at-rest secret store: SECRETS_ENC_KEY, else JWT_SECRET. Never empty. */
  secretsEncKey: string;
  /** HMAC key for stored API-key hashes: API_KEY_PEPPER, else derived from JWT_SECRET. */
  apiKeyPepper: string;
  /** Shared secret for POST /webhooks/inbound. Null = not configured (production refuses the route). */
  inboundWebhookSecret: string | null;
  /**
   * Which proxies may tell us the client address (Fastify `trustProxy`), from TRUST_PROXY:
   * unset/"false" → none (the socket address is the client; X-Forwarded-For is ignored),
   * a comma-separated list of addresses / CIDR ranges / the names loopback, linklocal,
   * uniquelocal → only those peers (the safe form), a number → that many hops, "true" → every
   * peer. The last two believe whatever X-Forwarded-For says and are only safe when the
   * origin is unreachable except through a proxy that sets that header itself.
   */
  trustProxy: boolean | number | string;
  /** Request-log level (pino). Null = logging off. Default: "info" in production, off elsewhere. */
  logLevel: string | null;
}

/** Secrets the boot guard vets in production. Optional ones are only checked when set. */
const OPTIONAL_SECRETS = ["SECRETS_ENC_KEY", "UNSUBSCRIBE_SECRET", "INBOUND_WEBHOOK_SECRET", "API_KEY_PEPPER"] as const;

/**
 * A positive number from an environment value, else `fallback`. A variable that is present
 * but empty (`PORT=`, or compose passing a blank through) must mean "default": `Number("")`
 * is 0 — a random port, or a scheduler that loops without pause. Zero, negative and
 * non-numeric values fall back too.
 */
export function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = (raw ?? "").trim();
  if (value === "" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isProduction = env.NODE_ENV === "production";
  // Present-but-empty counts as unset for every secret (see envSecret).
  const jwtSecret = envSecret(env, "JWT_SECRET") ?? DEV_INSECURE_SECRET;

  // Fail closed: production never boots on a missing, placeholder or guessable secret. The
  // message names the variable and the reason — never the value.
  if (isProduction) {
    const problems: string[] = [];
    if (!envSecret(env, "JWT_SECRET")) problems.push("JWT_SECRET is not set");
    else {
      const weakness = secretWeakness(jwtSecret);
      if (weakness) problems.push(`JWT_SECRET ${weakness}`);
    }
    for (const name of OPTIONAL_SECRETS) {
      const value = envSecret(env, name);
      const weakness = value ? secretWeakness(value) : null;
      if (weakness) problems.push(`${name} ${weakness}`);
    }
    if (problems.length > 0) {
      throw new Error(
        `Refusing to start in production: ${problems.join("; ")}. ` +
          "Generate secrets with `openssl rand -hex 32`; the optional ones may be left unset instead.",
      );
    }
  }

  // A variable that is present but empty (`NAME=` in a .env file, or compose passing an
  // unset value through) means "use the default" — never 0 hold days or an empty origin.
  const setting = (name: string): string | undefined => {
    const value = env[name];
    return value !== undefined && value.trim() !== "" ? value : undefined;
  };

  return {
    jwtSecret,
    defaultHoldDays: Number(setting("DEFAULT_HOLD_DAYS") ?? 14),
    defaultMinPayoutCents: Number(setting("DEFAULT_MIN_PAYOUT_CENTS") ?? 5000),
    autoApproveConversions: env.AUTO_APPROVE_CONVERSIONS !== "false",
    trackingBaseUrl: setting("TRACKING_BASE_URL") ?? "http://localhost:8788",
    corsOrigins: (setting("CORS_ORIGINS") ?? "http://localhost:5173").split(","),
    isProduction,
    exposeMagicLink: !isProduction,
    allowSyntheticDiscovery:
      setting("ALLOW_SYNTHETIC_DISCOVERY") != null ? setting("ALLOW_SYNTHETIC_DISCOVERY") === "true" : !isProduction,
    publicApiUrl: setting("PUBLIC_API_URL") ?? "http://localhost:8787",
    oauth: {
      microsoft:
        env.MS_OAUTH_CLIENT_ID && env.MS_OAUTH_CLIENT_SECRET
          ? { clientId: env.MS_OAUTH_CLIENT_ID, clientSecret: env.MS_OAUTH_CLIENT_SECRET }
          : undefined,
      google:
        env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
          ? { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET }
          : undefined,
    },
    secretsEncKey: envSecret(env, "SECRETS_ENC_KEY") ?? jwtSecret,
    apiKeyPepper: envSecret(env, "API_KEY_PEPPER") ?? deriveSecret(jwtSecret, "api-key-hash"),
    inboundWebhookSecret: envSecret(env, "INBOUND_WEBHOOK_SECRET") ?? null,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: setting("LOG_LEVEL")?.trim() ?? (isProduction ? "info" : null),
  };
}
