import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { createContext, type AppContext } from "./context.js";
import { resolvePrincipal } from "./auth/middleware.js";
import { HttpError } from "./errors.js";
import { allRouteModules } from "./routes/index.js";

/**
 * Build the Fastify application. Everything hangs off a single AppContext, so the
 * server is fully testable via app.inject() with no network or external services.
 */
export async function buildApp(ctxOverride?: Partial<AppContext>): Promise<FastifyInstance> {
  const ctx = createContext(ctxOverride);
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });

  await app.register(cors, { origin: ctx.config.corsOrigins, credentials: true });

  // Capture the raw JSON body (for HMAC verification of signed webhooks) while
  // still parsing it normally.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as { rawBody?: string }).rawBody = typeof body === "string" ? body : "";
    try {
      done(null, body && (body as string).length ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Basic per-IP rate limit on auth + public webhook routes (brute-force / abuse
  // guard). In-memory per process; production fronts this with a shared store.
  const limiter = createRateLimiter({ windowMs: 60_000, max: 30 });
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (url.startsWith("/auth/") || url.includes("/reply-webhook/") || url.includes("/track/postback/")) {
      const ip = (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || request.ip || "unknown";
      if (!limiter.allow(`${ip}:${url}`)) {
        return reply.status(429).send({ error: { message: "too many requests", code: "rate_limited" } });
      }
    }
  });

  // Resolve the principal for every request (routes enforce their own scope).
  app.addHook("preHandler", async (request) => {
    const principal = await resolvePrincipal(ctx, request);
    if (principal) request.principal = principal;
  });

  // Uniform error envelope.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: { message: error.message, code: error.code } });
    }
    const err = error as { statusCode?: number; message?: string; code?: string };
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) app.log.error(error);
    return reply.status(statusCode).send({ error: { message: err.message ?? "error", code: err.code ?? "error" } });
  });

  app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));
  app.get("/", async () => ({ name: "affiliate-platform-api", version: "0.1.0" }));

  for (const mod of allRouteModules) mod(app, ctx);

  // Expose the context for tests / embedding (e.g. the demo runs edge + api on one ctx).
  app.decorate("appContext", ctx);
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    appContext: AppContext;
  }
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** Tiny fixed-window in-memory rate limiter. */
function createRateLimiter(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    allow(key: string): boolean {
      const now = Date.now();
      const e = hits.get(key);
      if (!e || now > e.resetAt) {
        hits.set(key, { count: 1, resetAt: now + opts.windowMs });
        return true;
      }
      e.count += 1;
      return e.count <= opts.max;
    },
  };
}
