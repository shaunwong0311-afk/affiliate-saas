import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";

/**
 * AUDIT-2026-10 S10 — the compose stack did not work and was not safe: the worker had no
 * JWT_SECRET (and exits at boot, the image being NODE_ENV=production), the edge had no
 * DATABASE_URL (every link 404s), the API ran on the placeholder secret, Postgres and an
 * unused Redis were published on every interface with default credentials, there was no
 * .dockerignore, and the image was built with `npm install`.
 *
 * These are text-level checks on the deployment files (no YAML dependency, no Docker in the
 * test run); `docker compose -f deploy/docker-compose.yml config` validates the syntax.
 */
// (CRLF-normalized: a Windows checkout with autocrlf must not change what these checks see.)
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const compose = read("deploy/docker-compose.yml");
const dockerfile = read("deploy/Dockerfile");

/** Lines of a YAML file without comments (so prose in the header can mention anything). */
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

/** The body of one top-level section (`services:`) or one two-space-indented entry of it. */
function block(text: string, header: RegExp): string {
  const lines = code(text).split("\n");
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return "";
  const indent = lines[start]!.search(/\S/);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() !== "" && l.search(/\S/) <= indent);
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
}
const services = block(compose, /^services:/);
const service = (name: string) => block(compose, new RegExp(`^  ${name}:\\s*$`));
const anchor = (name: string) => block(compose, new RegExp(`^x-${name}:`));

describe("deploy/docker-compose.yml (S10)", () => {
  it("defines exactly the origin stack — and no unused Redis", () => {
    const names = [...services.matchAll(/^  ([a-z-]+):\s*$/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(["api", "edge", "postgres", "worker"]);
    expect(code(compose)).not.toMatch(/redis/i);
  });

  it("gives the API, the worker AND the edge the shared database and production mode", () => {
    expect(anchor("common-env")).toMatch(/^\s+NODE_ENV: production$/m);
    expect(anchor("common-env")).toMatch(/^\s+DATABASE_URL: postgres:\/\/.+@postgres:5432\//m);
    expect(anchor("app-env")).toMatch(/<<: \*common-env/);
    for (const name of ["api", "worker"]) expect(service(name), name).toMatch(/<<: \*app-env/);
    expect(service("edge")).toMatch(/<<: \*common-env/);
  });

  it("requires every secret from the operator — nothing boots on a placeholder", () => {
    expect(code(compose)).not.toContain("change-me");
    expect(anchor("app-env")).toMatch(/^\s+JWT_SECRET: \$\{JWT_SECRET:\?.+\}$/m);
    expect(service("postgres")).toMatch(/^\s+POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?.+\}$/m);
    expect(anchor("common-env")).toMatch(/\$\{POSTGRES_PASSWORD:\?/); // not a literal password in the URL
    expect(service("edge")).toMatch(/^\s+EDGE_DEFAULT_DEST: \$\{EDGE_DEFAULT_DEST:\?.+\}$/m);
    // …and what compose can only check for presence, the application checks for strength.
    expect(() => loadConfig({ NODE_ENV: "production", JWT_SECRET: "change-me-in-prod" })).toThrow();
  });

  it("publishes Postgres on loopback only, and nothing on all interfaces by default", () => {
    const published = [...code(compose).matchAll(/^\s+- "([^"]+)"\s*$/gm)].map((m) => m[1]!).filter((p) => /:\d+:\d+$/.test(p));
    expect(published).toContain("127.0.0.1:5432:5432");
    expect(published.every((p) => p.startsWith("127.0.0.1:") || p.startsWith("${BIND_ADDRESS:-127.0.0.1}:")), published.join(" ")).toBe(true);
    expect(service("worker")).not.toMatch(/^\s+ports:/m);
  });

  it("has a health check on every service, and the app waits for a healthy database", () => {
    for (const name of ["postgres", "api", "worker", "edge"]) expect(service(name), name).toMatch(/^\s+healthcheck:/m);
    for (const name of ["api", "worker", "edge"]) expect(service(name), name).toMatch(/postgres:\s*\n\s+condition: service_healthy/);
    expect(service("api")).toContain("/health");
    expect(service("edge")).toContain("/health");
  });

  it("never passes a blank through for a setting the app would read as 0 or ''", () => {
    // `NAME=` in the env file + a bare pass-through would reach the worker as an interval of 0 ms.
    expect(service("worker")).toMatch(/^\s+SCHEDULER_INTERVAL_MS: \$\{SCHEDULER_INTERVAL_MS:-\d+\}$/m);
    expect(anchor("app-env")).toMatch(/^\s+RELEVANCE_LLM_BASE_URL: \$\{RELEVANCE_LLM_BASE_URL:-https:\/\/\S+\}$/m);
    expect(anchor("app-env")).toMatch(/^\s+RELEVANCE_LLM_MODEL: \$\{RELEVANCE_LLM_MODEL:-\S+\}$/m);
  });

  it("does not run a second scheduler in the API next to the worker", () => {
    expect(service("api")).not.toMatch(/^\s+SCHEDULER:/m);
    expect(anchor("app-env")).not.toMatch(/^\s+SCHEDULER:/m);
    expect(service("worker")).toContain("packages/api/src/worker.ts");
  });

  it("describes persistence correctly in its header (DATABASE_URL selects Postgres; all three share it)", () => {
    expect(compose).not.toMatch(/default app runtime is the in-memory store/);
    expect(compose).not.toMatch(/set USE_POSTGRES=true to switch the adapter/);
    expect(compose).toMatch(/DATABASE_URL is what selects the Postgres adapter/);
  });
});

describe("deploy/Dockerfile + .dockerignore (S10)", () => {
  it("installs with `npm ci` (lockfile-exact), production dependencies only", () => {
    const run = code(dockerfile).split("\n").filter((l) => l.startsWith("RUN "));
    expect(run.some((l) => /npm ci\b.*--omit=dev/.test(l))).toBe(true);
    expect(code(dockerfile)).not.toMatch(/npm install/);
    expect(code(dockerfile)).toMatch(/^COPY .*package-lock\.json/m);
    expect(code(dockerfile)).not.toMatch(/package-lock\.json\*/); // the lock is required, not optional
  });

  it("does not run as root", () => {
    expect(code(dockerfile)).toMatch(/^USER node$/m);
  });

  it("has a .dockerignore that keeps local state and secrets out of the build context", () => {
    const ignore = read(".dockerignore").split("\n").map((l) => l.trim());
    for (const entry of [".env", ".env.*", ".git", "**/node_modules"]) expect(ignore, entry).toContain(entry);
  });
});
