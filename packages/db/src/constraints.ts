import type { Database } from "./ports.js";

/**
 * Uniqueness, declared ONCE and enforced by BOTH adapters: the in-memory store checks
 * these on every write, the Postgres adapter creates a unique index for each. Before this
 * file the only uniqueness in the system was the primary key; every "is there already
 * one?" check was read-then-write, which is safe only while requests never overlap.
 *
 * Rules of the model (identical in both adapters):
 *  - a row is exempt when ANY listed field is null or missing (SQL NULL semantics);
 *  - fields must hold strings (ids, emails, codes);
 *  - `ci` compares ASCII-case-insensitively.
 *
 * The `name` is also the Postgres index name (`uq_<name>`), so give a changed definition
 * a new name. Adding a rule to a database that already holds violating rows makes boot
 * fail with the offending rule named — resolve the duplicates rather than drop the rule.
 */
export type CollectionName = Exclude<keyof Database, "transaction" | "withLock" | "reset" | "close">;

export interface UniqueField {
  field: string;
  /** Compare case-insensitively (ASCII letters only, so both adapters agree byte for byte). */
  ci?: boolean;
}

export interface UniqueConstraint {
  name: string;
  collection: CollectionName;
  fields: readonly (string | UniqueField)[];
  /** Which code relies on it. */
  reason: string;
}

export const UNIQUE_CONSTRAINTS: readonly UniqueConstraint[] = [
  {
    name: "orders_merchant_txn",
    collection: "orders",
    fields: ["merchantId", "txnId"],
    reason: "order idempotency: one order per merchant-supplied txn id, however many times it is delivered",
  },
  {
    name: "customers_merchant_external",
    collection: "customers",
    fields: ["merchantId", "externalCustomerId"],
    reason: "the conversion pipeline finds-or-creates the customer by the merchant's own reference",
  },
  {
    name: "codes_merchant_code",
    collection: "codes",
    fields: ["merchantId", "code"],
    reason: "a coupon code at checkout must resolve to exactly one affiliate (it decides who is paid)",
  },
  {
    name: "ledger_reverses_entry",
    collection: "ledger",
    fields: ["reversesEntryId"],
    reason: "a ledger entry is clawed back at most once",
  },
  {
    name: "relationships_affiliate_program",
    collection: "relationships",
    fields: ["affiliateId", "programId"],
    reason: "attribution looks a relationship up by (affiliate, program); a second row would let a banned affiliate re-enter",
  },
  {
    name: "users_email",
    collection: "users",
    fields: [{ field: "email", ci: true }],
    reason: "login resolves a user by email",
  },
  {
    name: "affiliates_primary_email",
    collection: "affiliates",
    fields: [{ field: "primaryEmail", ci: true }],
    reason: "the global affiliate identity (portal login, payee) is found by email",
  },
];

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

function normalize(field: string | UniqueField): UniqueField {
  const f = typeof field === "string" ? { field } : field;
  if (!FIELD_NAME.test(f.field)) throw new Error(`invalid unique-constraint field name: ${f.field}`);
  return f;
}

export function constraintFieldNames(constraint: UniqueConstraint): string[] {
  return constraint.fields.map((f) => normalize(f).field);
}

export function constraintsFor(collection: string): UniqueConstraint[] {
  return UNIQUE_CONSTRAINTS.filter((c) => c.collection === collection);
}

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * The value a row occupies under a constraint, or null when the row is exempt. Mirrors the
 * Postgres index expression exactly (`doc->>'field'`, `lower(... COLLATE "C")`).
 */
export function uniqueKeyOf(constraint: UniqueConstraint, row: unknown): string | null {
  const parts: string[] = [];
  for (const raw of constraint.fields) {
    const f = normalize(raw);
    const value = (row as Record<string, unknown> | null | undefined)?.[f.field];
    if (value === null || value === undefined) return null;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(f.ci ? asciiLower(text) : text);
  }
  return JSON.stringify(parts);
}

export const uniqueIndexName = (constraint: UniqueConstraint): string => `uq_${constraint.name}`;

/** `CREATE UNIQUE INDEX` for one constraint on its document table. */
export function uniqueIndexDdl(constraint: UniqueConstraint, table: string): string {
  const exprs = constraint.fields.map((raw) => {
    const f = normalize(raw);
    const text = `(doc->>'${f.field}')`;
    return f.ci ? `lower(${text} COLLATE "C")` : text;
  });
  return `CREATE UNIQUE INDEX IF NOT EXISTS ${uniqueIndexName(constraint)} ON ${table} (${exprs.join(", ")})`;
}
