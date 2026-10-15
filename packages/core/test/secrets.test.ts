import { describe, it, expect } from "vitest";
import {
  DEV_INSECURE_SECRET,
  MIN_SECRET_LENGTH,
  constantTimeEqual,
  deriveSecret,
  envSecret,
  resolveUnsubscribeSecret,
  secretWeakness,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../src/index.js";

/** AUDIT-2026-10 S4 — one definition of "set", "strong" and "the unsubscribe secret". */
const STRONG = "7a9c1e3b5d7f9a0c2e4b6d8f1a3c5e7b9d0f2a4c6e8b1d3f";
const OTHER = "0f2e4d6c8b1a3f5e7d9c0b2a4f6e8d1c3b5a7f9e0d2c4b6a";

describe("envSecret", () => {
  it("treats a variable that is present but empty (or blank) as unset", () => {
    expect(envSecret({ S: "" }, "S")).toBeUndefined();
    expect(envSecret({ S: "   " }, "S")).toBeUndefined();
    expect(envSecret({}, "S")).toBeUndefined();
    expect(envSecret({ S: "value" }, "S")).toBe("value");
  });
});

describe("secretWeakness", () => {
  it("accepts a random secret of the minimum length or more", () => {
    expect(secretWeakness(STRONG)).toBeNull();
    expect(secretWeakness(STRONG.slice(0, MIN_SECRET_LENGTH))).toBeNull();
  });

  it("rejects the documented placeholders, however they are padded or cased", () => {
    for (const value of ["change-me-in-prod", DEV_INSECURE_SECRET, "CHANGE-ME-IN-PROD", "changeme", "secret", "password", `change-me-in-prod-${STRONG}`, "please-replace-me-with-a-real-secret-0123"]) {
      expect(secretWeakness(value), value).toBe("is a placeholder value");
    }
  });

  it("rejects short and low-variety values", () => {
    expect(secretWeakness("x")).toMatch(/at least 32 characters/);
    expect(secretWeakness(STRONG.slice(0, MIN_SECRET_LENGTH - 1))).toMatch(/at least 32 characters/);
    expect(secretWeakness("a".repeat(64))).toMatch(/too little variety/);
    expect(secretWeakness("01".repeat(32))).toMatch(/too little variety/);
  });
});

describe("resolveUnsubscribeSecret", () => {
  it("prefers UNSUBSCRIBE_SECRET, then JWT_SECRET, then (outside production) the dev default", () => {
    expect(resolveUnsubscribeSecret({ UNSUBSCRIBE_SECRET: OTHER, JWT_SECRET: STRONG })).toBe(OTHER);
    expect(resolveUnsubscribeSecret({ JWT_SECRET: STRONG })).toBe(STRONG);
    expect(resolveUnsubscribeSecret({})).toBe(DEV_INSECURE_SECRET);
  });

  it("never returns an empty key: a present-but-empty variable falls through", () => {
    expect(resolveUnsubscribeSecret({ UNSUBSCRIBE_SECRET: "", JWT_SECRET: STRONG })).toBe(STRONG);
    expect(resolveUnsubscribeSecret({ UNSUBSCRIBE_SECRET: "", JWT_SECRET: "" })).toBe(DEV_INSECURE_SECRET);
  });

  it("fails closed in production when nothing is configured (no signing with the dev default)", () => {
    expect(() => resolveUnsubscribeSecret({ NODE_ENV: "production" })).toThrow(/must be set in production/);
    expect(() => resolveUnsubscribeSecret({ NODE_ENV: "production", UNSUBSCRIBE_SECRET: "", JWT_SECRET: "" })).toThrow();
    expect(resolveUnsubscribeSecret({ NODE_ENV: "production", JWT_SECRET: STRONG })).toBe(STRONG);
  });

  it("signer and verifier agree when both resolve through it", () => {
    const env = { UNSUBSCRIBE_SECRET: "", JWT_SECRET: STRONG };
    const token = signUnsubscribeToken("m1", "Reader@Example.com", resolveUnsubscribeSecret(env));
    expect(verifyUnsubscribeToken("m1", "reader@example.com", token, resolveUnsubscribeSecret(env))).toBe(true);
    expect(verifyUnsubscribeToken("m1", "reader@example.com", signUnsubscribeToken("m1", "reader@example.com", ""), resolveUnsubscribeSecret(env))).toBe(false);
  });
});

describe("deriveSecret", () => {
  it("is deterministic, purpose-separated, and never the master secret", () => {
    expect(deriveSecret(STRONG, "api-key-hash")).toBe(deriveSecret(STRONG, "api-key-hash"));
    expect(deriveSecret(STRONG, "api-key-hash")).not.toBe(deriveSecret(STRONG, "something-else"));
    expect(deriveSecret(STRONG, "api-key-hash")).not.toBe(deriveSecret(OTHER, "api-key-hash"));
    expect(deriveSecret(STRONG, "api-key-hash")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("constantTimeEqual", () => {
  it("compares secrets of any length without throwing", () => {
    expect(constantTimeEqual(STRONG, STRONG)).toBe(true);
    expect(constantTimeEqual(STRONG, OTHER)).toBe(false);
    expect(constantTimeEqual(STRONG, STRONG.slice(0, -1))).toBe(false);
    expect(constantTimeEqual("", STRONG)).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
