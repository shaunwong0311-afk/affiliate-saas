import type { SecretStore } from "./ports.js";

/**
 * Encrypted secret storage for OAuth/API credentials (Section 11). Rows store
 * only a `credentials_ref`, never the raw secret; the secret lives here. Default
 * is in-memory for dev; production uses a KMS-backed store.
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
