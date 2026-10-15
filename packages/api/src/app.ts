import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import { createContext, type AppContext } from "./context.js";
import { resolvePrincipal } from "./auth/middleware.js";
import { AUTH_LIMIT, PUBLIC_FORM_LIMIT, SIGNED_ENDPOINT_LIMIT, RateLimiter, clientKey, type RateRule } from "./auth/rate-limit.js";
import { HttpError, isDataNotFound } from "./errors.js";
import { allRouteModules } from "./routes/index.js";

export interface BuildAppOptions {
  /**
   * Where request logs are written (default: stdout). Logging itself is governed by
   * `config.logLevel` — "info" in production, off elsewhere unless LOG_LEVEL is set.
   */
  logStream?: { write(line: string): void };
}

/**
 * Build the Fastify application. Everything hangs off a single AppContext, so the
 * server is fully testable via app.inject() with no network or external services.
 */
export async function buildApp(ctxOverride?: Partial<AppContext>, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const ctx = createContext(ctxOverride);
  const app = Fastify({
    logger: loggerOptions(ctx.config.logLevel, options.logStream),
    bodyLimit: 1_048_576,
    // Decides whether X-Forwarded-For is believed: `request.ip` is the socket peer unless
    // that peer is a proxy the operator listed in TRUST_PROXY.
    trustProxy: ctx.config.trustProxy,
  });

  await app.register(cors, { origin: ctx.config.corsOrigins, credentials: true, exposedHeaders: ["content-disposition"] });

  // Capture the raw JSON body (for HMAC verification of signed webhooks) while
  // still parsing it normally.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as { rawBody?: string }).rawBody = typeof body === "string" ? body : "";
    try {
      done(null, body && (body as string).length ? JSON.parse(body as string) : {});
    } catch {
      // A body that is not JSON is the client's mistake (400), not a server fault (500).
      done(new HttpError(400, "invalid JSON body", "bad_request"), undefined);
    }
  });

  // Per-client rate limit on the unauthenticated surface (brute-force / abuse guard).
  // In-memory per process; a multi-instance deployment fronts this with a shared store.
  //  - the client is `request.ip` — never a header the caller can set (see trustProxy);
  //  - the bucket is the MATCHED ROUTE, not the raw URL, so `/%61uth/login` or a varied
  //    path parameter cannot mint a fresh bucket.
  const limiter = new RateLimiter();
  app.decorate("rateLimiter", limiter);
  app.addHook("onRequest", async (request, reply) => {
    const pattern = request.routeOptions.url;
    const rule = pattern ? rateRuleFor(request.method, pattern) : null;
    if (!rule) return;
    const decision = limiter.hit(`${clientKey(request.ip)}|${request.method}|${pattern}`, rule);
    if (!decision.allowed) {
      return reply
        .status(429)
        .header("retry-after", String(decision.retryAfterSeconds))
        .send({ error: { message: "too many requests", code: "rate_limited" } });
    }
  });

  // Resolve the principal for every request (routes enforce their own scope).
  app.addHook("preHandler", async (request) => {
    const principal = await resolvePrincipal(ctx, request);
    if (principal) request.principal = principal;
  });

  // Uniform error envelope.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, "request failed");
      return reply.status(error.statusCode).send({ error: { message: error.message, code: error.code } });
    }
    if (isDataNotFound(error)) {
      // `repo.require()` / `repo.update()` on a missing row: the id goes to the log, not the client.
      request.log.info({ err: error }, "row not found");
      return reply.status(404).send({ error: { message: "not found", code: "not_found" } });
    }
    const err = error as { statusCode?: unknown; message?: string; code?: string };
    const statusCode = typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode <= 599 ? err.statusCode : 500;
    if (statusCode >= 500) {
      // The real error is logged; a production client only ever sees a generic message
      // (internal messages name tables, ids, hosts and upstream providers).
      request.log.error({ err: error }, "unhandled error");
      if (ctx.config.isProduction) {
        return reply.status(statusCode).send({ error: { message: "internal error", code: "internal_error" } });
      }
    }
    return reply.status(statusCode).send({ error: { message: err.message ?? "error", code: err.code ?? "error" } });
  });

  // Unknown routes: the same envelope as every other error, and a log line WITHOUT the query
  // string (Fastify's default 404 logs the full URL — unsubscribe tokens and addresses included).
  app.setNotFoundHandler((request, reply) => {
    request.log.info({ path: request.url.split("?")[0] }, "route not found");
    return reply.status(404).send({ error: { message: "not found", code: "not_found" } });
  });

  // Polled by the container health check — keep it out of the request log.
  app.get("/health", { logLevel: "warn" }, async () => ({ status: "ok", ts: new Date().toISOString() }));
  app.get("/", async () => ({ name: "affiliate-platform-api", version: "0.1.0" }));

  for (const mod of allRouteModules) mod(app, ctx);

  // Expose the context for tests / embedding (e.g. the demo runs edge + api on one ctx).
  app.decorate("appContext", ctx);
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    appContext: AppContext;
    /** The shared abuse limiter — public handlers add per-target buckets (e.g. per email). */
    rateLimiter: RateLimiter;
  }
  interface FastifyRequest {
    rawBody?: string;
  }
}

/**
 * Which limit applies to a matched route (`request.routeOptions.url`, e.g. `/join/:merchantId`).
 * Tight where a caller can guess credentials or make the platform create rows and send mail;
 * a flood guard only where the caller already has to present an HMAC or shared secret.
 */
export function rateRuleFor(method: string, pattern: string): RateRule | null {
  if (method === "POST" && pattern.startsWith("/auth/")) return AUTH_LIMIT;
  if (method === "POST" && (pattern.startsWith("/join/") || /^\/programs\/[^/]+\/apply$/.test(pattern))) return PUBLIC_FORM_LIMIT;
  if (
    pattern.startsWith("/track/postback/") ||
    pattern.startsWith("/recruitment/reply-webhook/") ||
    pattern === "/webhooks/inbound" ||
    pattern === "/track/unsubscribe"
  ) {
    return SIGNED_ENDPOINT_LIMIT;
  }
  return null;
}

/** Structured (JSON) request + error logs at `level`; off when no level is configured. */
function loggerOptions(level: string | null, stream: BuildAppOptions["logStream"]): FastifyServerOptions["logger"] {
  if (!level) return false;
  return {
    level,
    ...(stream ? { stream } : {}),
    serializers: {
      // Path only: query strings carry unsubscribe tokens, OAuth codes and email addresses.
      req: (request: FastifyRequest) => ({ method: request.method, url: request.url.split("?")[0], remoteAddress: request.ip }),
    },
  };
}
