import { describe, it, expect } from "vitest";
import { DbSecretStore, type SecretRepo } from "../src/index.js";

function memRepo(): SecretRepo & { rows: Map<string, { id: string; value: string; updatedAt: string }> } {
  const rows = new Map<string, { id: string; value: string; updatedAt: string }>();
  return {
    rows,
    async get(id) {
      return rows.get(id) ?? null;
    },
    async upsert(row) {
      rows.set(row.id, row);
      return row;
    },
    async delete(id) {
      rows.delete(id);
    },
  };
}

describe("DbSecretStore", () => {
  it("round-trips a secret and never persists plaintext", async () => {
    const repo = memRepo();
    const store = new DbSecretStore(repo, "a-strong-key");
    await store.put("mailbox:m1:creds", '{"kind":"smtp","pass":"hunter2"}');

    expect(await store.get("mailbox:m1:creds")).toBe('{"kind":"smtp","pass":"hunter2"}');
    const persisted = repo.rows.get("mailbox:m1:creds")!.value;
    expect(persisted).not.toContain("hunter2"); // encrypted at rest
    expect(persisted.startsWith("v1:")).toBe(true);
  });

  it("returns null (not garbage) for a wrong key or tampered envelope", async () => {
    const repo = memRepo();
    await new DbSecretStore(repo, "key-one").put("ref", "secret");
    expect(await new DbSecretStore(repo, "key-two").get("ref")).toBeNull();

    const row = repo.rows.get("ref")!;
    repo.rows.set("ref", { ...row, value: row.value.slice(0, -4) + "AAAA" });
    expect(await new DbSecretStore(repo, "key-one").get("ref")).toBeNull();
  });

  it("overwrites on put and deletes cleanly", async () => {
    const repo = memRepo();
    const store = new DbSecretStore(repo, "k");
    await store.put("r", "one");
    await store.put("r", "two");
    expect(await store.get("r")).toBe("two");
    await store.delete("r");
    expect(await store.get("r")).toBeNull();
  });
});
