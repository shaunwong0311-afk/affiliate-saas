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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    jwtSecret: env.JWT_SECRET ?? "dev-insecure-secret-change-me",
    defaultHoldDays: Number(env.DEFAULT_HOLD_DAYS ?? 14),
    defaultMinPayoutCents: Number(env.DEFAULT_MIN_PAYOUT_CENTS ?? 5000),
    autoApproveConversions: env.AUTO_APPROVE_CONVERSIONS !== "false",
    trackingBaseUrl: env.TRACKING_BASE_URL ?? "http://localhost:8788",
    corsOrigins: (env.CORS_ORIGINS ?? "http://localhost:5173").split(","),
  };
}
