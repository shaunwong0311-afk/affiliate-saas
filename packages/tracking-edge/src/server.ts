import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createDatabaseFromEnv, type Database } from "@affiliate/db";
import { createRedirectHandler, decodeLinkCode, type RedirectInput } from "./handler.js";
import { DbLinkResolver, DbClickSink } from "./adapters.js";

/**
 * Node host for the redirect handler — used by the demo and for local dev. In
 * production the redirect runs on Cloudflare Workers (worker.ts); this exists so
 * the exact same handler is exercisable without an edge runtime.
 *
 * Route: GET /c/:code?to=<dest>&sub1=...  → 302 to dest with click_id appended.
 *        GET /health                      → 200 (container health check).
 */
export function createEdgeServer(db: Database, opts: { defaultDestination?: string } = {}) {
  const handler = createRedirectHandler(new DbLinkResolver(db, opts), new DbClickSink(db));

  return createServer((req, res) => {
    // Nothing a client sends may throw out of this listener (an uncaught exception here
    // takes the whole process down): an unparseable request line / Host header or a
    // malformed percent-escape in the code is the caller's mistake — 400.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    const match = url.pathname.match(/^\/c\/([^/]+)$/);
    if (!match) {
      res.writeHead(404).end("not found");
      return;
    }
    const code = decodeLinkCode(match[1]!);
    if (code === null) {
      res.writeHead(400).end("malformed tracking link");
      return;
    }
    const pending: Promise<unknown>[] = [];
    const input: RedirectInput = {
      code,
      url,
      ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null,
      ua: (req.headers["user-agent"] as string) ?? null,
      defer: (p) => pending.push(p),
    };

    handler(input)
      .then(async (decision) => {
        const headers: Record<string, string> = {};
        if (decision.location) headers["Location"] = decision.location;
        if (decision.setCookie) headers["Set-Cookie"] = decision.setCookie;
        res.writeHead(decision.status, headers).end(decision.body ?? "");
        // Flush async click writes after responding (mirrors Workers waitUntil).
        await Promise.allSettled(pending);
      })
      .catch(() => {
        res.writeHead(500).end("error");
      });
  });
}

/**
 * The fallback destination for links (EDGE_DEFAULT_DEST). Outside production an unset value
 * falls back to a reserved example host so the demo runs; in production a missing or invalid
 * value is refused — real clicks must never be redirected to a placeholder.
 */
export function resolveDefaultDestination(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.EDGE_DEFAULT_DEST ?? "").trim();
  if (!configured) {
    if (env.NODE_ENV === "production") throw new Error("EDGE_DEFAULT_DEST must be set in production (the URL tracking links redirect to)");
    return "https://example.com/";
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("EDGE_DEFAULT_DEST is not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("EDGE_DEFAULT_DEST must be an http(s) URL");
  return configured;
}

// Only auto-start when THIS module is the process entrypoint (not when imported
// by the API, which also has a file named server.ts).
const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  // (`||`: a blank EDGE_PORT must mean the default, not port 0 = "any free port".)
  const port = Number(process.env.EDGE_PORT || 8788) || 8788;
  // Share the SAME persistence as the API/worker (Postgres when configured) so the
  // edge's click writes are visible to the conversion pipeline.
  Promise.resolve()
    .then(() => resolveDefaultDestination())
    .then(async (defaultDestination) => {
      const db = await createDatabaseFromEnv();
      createEdgeServer(db, { defaultDestination }).listen(port, () => {
        // eslint-disable-next-line no-console
        console.log(`tracking edge listening on http://localhost:${port}/c/:code`);
      });
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
