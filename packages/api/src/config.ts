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
  };
}
