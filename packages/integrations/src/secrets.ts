import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SecretStore } from "./ports.js";

/**
 * Encrypted secret storage for OAuth/API credentials (Section 11). Rows store
 * only a `credentials_ref`, never the raw secret; the secret lives here. Default
 * is in-memory for dev; production uses the database-backed encrypted store.
 */
export class InMemorySecretStore implements SecretStore {
  private readonly store = new Map<string, string>();
  async put(ref: string, value: string): Promise<void> {
    this.store.set(ref, value);
  }
  async get(ref: string): Promise<string | null> {
    return this.store.get(ref) ?? null;
  }
  async delete(ref: string): Promise<void> {
    this.store.delete(ref);
  }
}

/** Reads secrets from environment variables keyed by ref (e.g. SECRET_<REF>). */
export class EnvSecretStore implements SecretStore {
  async put(): Promise<void> {
    throw new Error("EnvSecretStore is read-only");
  }
  async get(ref: string): Promise<string | null> {
    return process.env[`SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] ?? null;
  }
  async delete(): Promise<void> {
    throw new Error("EnvSecretStore is read-only");
  }
}

/** The minimal slice of a db repo the store needs (structural — @affiliate/db's Repo fits). */
export interface SecretRepo {
  get(id: string): Promise<{ id: string; value: string; updatedAt: string } | null>;
  upsert(row: { id: string; value: string; updatedAt: string }): Promise<unknown>;
  delete(id: string): Promise<void>;
}

/**
 * Database-backed secret store with app-level AES-256-GCM encryption. Secrets survive a
 * process restart whenever the database does — without this, every connected mailbox's
 * `credentialsRef` dangles after a redeploy and outreach silently degrades to the mock
 * sender. The envelope is `v1:<iv>:<tag>:<ciphertext>` (base64url); the key is derived
 * from the secret the caller resolves (the API passes SECRETS_ENC_KEY, else JWT_SECRET; an
 * env var that is present but empty counts as unset, and production vets both at boot).
 */
export class DbSecretStore implements SecretStore {
  private readonly key: Buffer;
  constructor(
    private readonly repo: SecretRepo,
    encryptionSecret: string,
  ) {
    // Fail closed: an empty secret would silently derive the same well-known key everywhere.
    if (typeof encryptionSecret !== "string" || encryptionSecret.trim() === "") {
      throw new Error("DbSecretStore requires a non-empty encryption secret");
    }
    this.key = createHash("sha256").update(encryptionSecret).digest();
  }

  async put(ref: string, value: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const envelope = `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${enc.toString("base64url")}`;
    await this.repo.upsert({ id: ref, value: envelope, updatedAt: new Date().toISOString() });
  }

  async get(ref: string): Promise<string | null> {
    const row = await this.repo.get(ref);
    if (!row) return null;
    const [v, ivB64, tagB64, dataB64] = row.value.split(":");
    if (v !== "v1" || !ivB64 || !tagB64 || !dataB64) return null; // unreadable envelope → treat as missing, never guess
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB64, "base64url"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      return null; // wrong key / tampered → missing, not garbage
    }
  }

  async delete(ref: string): Promise<void> {
    await this.repo.delete(ref);
  }
}
