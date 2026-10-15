import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { signUnsubscribeToken } from "@affiliate/core";
import { createMemoryDatabase } from "@affiliate/db";
import { DbSecretStore } from "@affiliate/integrations";
import { unsubscribeLink } from "@affiliate/recruitment";
import { buildApp } from "../src/app.js";
import { loadConfig, positiveNumber } from "../src/config.js";
import { createContext } from "../src/context.js";

/**
 * AUDIT-2026-10 S4 — the production boot guard rejected exactly one string, so
 * `JWT_SECRET=change-me-in-prod` (the value `.env.example` and docker-compose shipped) and
 * `JWT_SECRET=x` both booted. And SECRETS_ENC_KEY / UNSUBSCRIBE_SECRET used `??`, so a
 * variable that is present but empty (again, as shipped) BECAME the key.
 */
const STRONG = "3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d";
const OTHER = "c4e6a8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f1";

/** Set (or, with undefined, truly remove) a process env var for one test. */
const savedEnv = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

describe("production boot guard (S4)", () => {
  it.each([
    ["the placeholder from .env.example and docker-compose", "change-me-in-prod"],
    ["the development default", "dev-insecure-secret-change-me"],
    ["a placeholder padded past the length check", "change-me-in-prod-change-me-in-prod-change-me"],
    ["a single character", "x"],
    ["31 characters (one short of the minimum)", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p"],
    ["one character repeated 64 times", "a".repeat(64)],
    ["an empty value", ""],
    ["whitespace", "    "],
  ])("refuses to boot when JWT_SECRET is %s", (_label, value) => {
    expect(() => loadConfig({ NODE_ENV: "production", JWT_SECRET: value })).toThrow(/JWT_SECRET/);
  });

  it("refuses to boot when JWT_SECRET is missing", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/JWT_SECRET is not set/);
  });

  it.each(["SECRETS_ENC_KEY", "UNSUBSCRIBE_SECRET", "INBOUND_WEBHOOK_SECRET", "API_KEY_PEPPER"])("refuses a weak %s even when JWT_SECRET is strong", (name) => {
    expect(() => loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG, [name]: "change-me-in-prod" })).toThrow(new RegExp(name));
    expect(() => loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG, [name]: "short" })).toThrow(new RegExp(name));
  });

  it("names the variable and the reason, never the value", () => {
    const leaked = "hunter2-hunter2-hunter2";
    let message = "";
    try {
      loadConfig({ NODE_ENV: "production", JWT_SECRET: leaked });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/JWT_SECRET must be at least 32 characters/);
    expect(message).not.toContain("hunter2");
  });

  it("boots with strong secrets", () => {
    const config = loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG, SECRETS_ENC_KEY: OTHER });
    expect(config.isProduction).toBe(true);
    expect(config.jwtSecret).toBe(STRONG);
    expect(config.secretsEncKey).toBe(OTHER);
  });

  it("optional secrets that are present but EMPTY count as unset — they never become the key", () => {
    const config = loadConfig({ NODE_ENV: "production", JWT_SECRET: STRONG, SECRETS_ENC_KEY: "", UNSUBSCRIBE_SECRET: "", INBOUND_WEBHOOK_SECRET: "", API_KEY_PEPPER: "" });
    expect(config.secretsEncKey).toBe(STRONG);
    expect(config.inboundWebhookSecret).toBeNull();
    expect(config.apiKeyPepper).toMatch(/^[0-9a-f]{64}$/);
  });

  it("outside production nothing is refused (zero-config development still works)", () => {
    expect(loadConfig({}).jwtSecret).toBe("dev-insecure-secret-change-me");
    expect(loadConfig({ JWT_SECRET: "" }).jwtSecret).toBe("dev-insecure-secret-change-me");
    expect(loadConfig({ NODE_ENV: "development", JWT_SECRET: "x" }).jwtSecret).toBe("x");
  });
});

describe("settings that are present but empty use their default", () => {
  it("an empty value (a bare `NAME=` line, or compose passing it through) never becomes 0 days or an empty origin", () => {
    const config = loadConfig({ DEFAULT_HOLD_DAYS: "", DEFAULT_MIN_PAYOUT_CENTS: " ", CORS_ORIGINS: "", PUBLIC_API_URL: "", TRACKING_BASE_URL: "", LOG_LEVEL: "", TRUST_PROXY: "", ALLOW_SYNTHETIC_DISCOVERY: "" });
    expect(config).toMatchObject(loadConfig({}));
    expect(config.defaultHoldDays).toBe(14);
    expect(config.defaultMinPayoutCents).toBe(5000);
    expect(config.corsOrigins).toEqual(["http://localhost:5173"]);
  });

  it("positiveNumber: blank, zero, negative and non-numeric values all mean the default (never port 0 or a 0 ms interval)", () => {
    for (const raw of [undefined, "", "   ", "0", "-5", "abc", "NaN"]) expect(positiveNumber(raw, 60_000), String(raw)).toBe(60_000);
    expect(positiveNumber("8787", 1)).toBe(8787);
    expect(positiveNumber(" 15000 ", 1)).toBe(15000);
  });

  it("explicit values still win", () => {
    const config = loadConfig({ DEFAULT_HOLD_DAYS: "30", CORS_ORIGINS: "https://app.example.com,https://admin.example.com", PUBLIC_API_URL: "https://api.example.com" });
    expect(config.defaultHoldDays).toBe(30);
    expect(config.corsOrigins).toEqual(["https://app.example.com", "https://admin.example.com"]);
    expect(config.publicApiUrl).toBe("https://api.example.com");
  });
});

describe("the secret store never runs on an empty key (S4)", () => {
  it("SECRETS_ENC_KEY= (present, empty) falls back to JWT_SECRET instead of encrypting with ''", async () => {
    setEnv("SECRETS_ENC_KEY", "");
    const db = createMemoryDatabase();
    const ctx = createContext({ db, config: loadConfig({ JWT_SECRET: STRONG, SECRETS_ENC_KEY: "" }) });
    await ctx.secrets.put("mailbox:m1:creds", "hunter2");
    // Readable with the JWT-secret fallback — i.e. that is the key it was encrypted under.
    expect(await new DbSecretStore(db.secrets, STRONG).get("mailbox:m1:creds")).toBe("hunter2");
    expect(() => new DbSecretStore(db.secrets, "")).toThrow(/non-empty/);
  });
});

describe("API and recruitment engine resolve the unsubscribe secret identically (S4)", () => {
  let app: FastifyInstance;
  const email = "reader@example.com";
  const pathOf = (link: string) => {
    const url = new URL(link);
    return url.pathname + url.search;
  };
  const forged = (secret: string) => `/track/unsubscribe?m=m1&e=${encodeURIComponent(email)}&t=${signUnsubscribeToken("m1", email, secret)}`;

  it.each([
    ["nothing set (development default)", {} as Record<string, string>],
    ["JWT_SECRET only", { JWT_SECRET: STRONG }],
    ["UNSUBSCRIBE_SECRET set", { JWT_SECRET: STRONG, UNSUBSCRIBE_SECRET: OTHER }],
    ["UNSUBSCRIBE_SECRET present but empty", { JWT_SECRET: STRONG, UNSUBSCRIBE_SECRET: "" }],
    ["both present but empty", { JWT_SECRET: "", UNSUBSCRIBE_SECRET: "" }],
  ])("a link the engine signs is accepted by the API — %s", async (_label, env) => {
    // Remove whatever the host shell has, then apply this case.
    setEnv("JWT_SECRET", undefined);
    setEnv("UNSUBSCRIBE_SECRET", undefined);
    for (const [k, v] of Object.entries(env)) setEnv(k, v);
    app = await buildApp();

    const res = await app.inject({ method: "GET", url: pathOf(unsubscribeLink("m1", email)) });
    expect(res.statusCode).toBe(200);
    // A token signed with the EMPTY string must never verify: that is what `"" ?? fallback` produced.
    expect((await app.inject({ method: "GET", url: forged("") })).statusCode).toBe(400);
  });

  it("UNSUBSCRIBE_SECRET wins over JWT_SECRET on both sides", async () => {
    setEnv("JWT_SECRET", STRONG);
    setEnv("UNSUBSCRIBE_SECRET", OTHER);
    app = await buildApp();
    expect((await app.inject({ method: "GET", url: forged(OTHER) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: forged(STRONG) })).statusCode).toBe(400);
  });
});
