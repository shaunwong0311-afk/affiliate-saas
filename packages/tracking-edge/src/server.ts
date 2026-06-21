import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createDatabaseFromEnv, type Database } from "@affiliate/db";
import { createRedirectHandler, type RedirectInput } from "./handler.js";
import { DbLinkResolver, DbClickSink } from "./adapters.js";

/**
 * Node host for the redirect handler — used by the demo and for local dev. In
 * production the redirect runs on Cloudflare Workers (worker.ts); this exists so
 * the exact same handler is exercisable without an edge runtime.
 *
 * Route: GET /c/:code?to=<dest>&sub1=...  → 302 to dest with click_id appended.
 */
export function createEdgeServer(db: Database, opts: { defaultDestination?: string } = {}) {
  const handler = createRedirectHandler(new DbLinkResolver(db, opts), new DbClickSink(db));

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const match = url.pathname.match(/^\/c\/([^/]+)$/);
    if (!match) {
      res.writeHead(404).end("not found");
      return;
    }
    const pending: Promise<unknown>[] = [];
    const input: RedirectInput = {
      code: decodeURIComponent(match[1]!),
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

// Only auto-start when THIS module is the process entrypoint (not when imported
// by the API, which also has a file named server.ts).
const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const port = Number(process.env.EDGE_PORT ?? 8788);
  // Share the SAME persistence as the API/worker (Postgres when configured) so the
  // edge's click writes are visible to the conversion pipeline.
  createDatabaseFromEnv()
    .then((db) => {
      createEdgeServer(db, { defaultDestination: process.env.EDGE_DEFAULT_DEST ?? "https://example.com/" }).listen(port, () => {
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
