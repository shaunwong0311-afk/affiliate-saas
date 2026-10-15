import { describe, it, expect } from "vitest";
import { DbSecretStore, type SecretRepo } from "../src/index.js";

/**
 * AUDIT-2026-10 S4 — `SECRETS_ENC_KEY=` (present, empty) used to reach the store as "" and
 * every mailbox credential was then encrypted under SHA-256("") — a key anyone can compute.
 * The store itself now refuses an empty secret, whatever the caller resolved.
 */
const repo = (): SecretRepo => {
  const rows = new Map<string, { id: string; value: string; updatedAt: string }>();
  return {
    get: async (id) => rows.get(id) ?? null,
    upsert: async (row) => void rows.set(row.id, row),
    delete: async (id) => void rows.delete(id),
  };
};

describe("DbSecretStore encryption secret", () => {
  it("refuses an empty or blank secret instead of deriving a well-known key", () => {
    expect(() => new DbSecretStore(repo(), "")).toThrow(/non-empty encryption secret/);
    expect(() => new DbSecretStore(repo(), "   ")).toThrow(/non-empty encryption secret/);
    expect(() => new DbSecretStore(repo(), undefined as unknown as string)).toThrow(/non-empty encryption secret/);
  });

  it("still works with a real secret", async () => {
    const store = new DbSecretStore(repo(), "a-real-secret-0123456789abcdef-0123456789");
    await store.put("ref", "value");
    expect(await store.get("ref")).toBe("value");
  });
});
