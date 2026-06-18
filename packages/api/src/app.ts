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
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: ctx.config.corsOrigins, credentials: true });

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
}
