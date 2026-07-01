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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const isProduction = env.NODE_ENV === "production";
  const jwtSecret = env.JWT_SECRET ?? "dev-insecure-secret-change-me";
  // Fail closed: refuse to boot in production with the insecure default secret.
  if (isProduction && jwtSecret === "dev-insecure-secret-change-me") {
    throw new Error("JWT_SECRET must be set to a strong value in production");
  }
  return {
    jwtSecret,
    defaultHoldDays: Number(env.DEFAULT_HOLD_DAYS ?? 14),
    defaultMinPayoutCents: Number(env.DEFAULT_MIN_PAYOUT_CENTS ?? 5000),
    autoApproveConversions: env.AUTO_APPROVE_CONVERSIONS !== "false",
    trackingBaseUrl: env.TRACKING_BASE_URL ?? "http://localhost:8788",
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:5173").split(","),
    isProduction,
    exposeMagicLink: !isProduction,
    allowSyntheticDiscovery:
      env.ALLOW_SYNTHETIC_DISCOVERY != null ? env.ALLOW_SYNTHETIC_DISCOVERY === "true" : !isProduction,
    publicApiUrl: env.PUBLIC_API_URL ?? "http://localhost:8787",
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
  };
}
