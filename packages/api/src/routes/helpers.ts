import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z, type ZodTypeAny } from "zod";
import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";

/** A route module registers handlers on the app, closing over the AppContext. */
export type RouteModule = (app: FastifyInstance, ctx: AppContext) => void;

/** Parse + validate a request body with a zod schema, throwing 400 on failure. */
export function parseBody<T extends ZodTypeAny>(schema: T, request: FastifyRequest): z.infer<T> {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    throw badRequest("validation: " + result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
  }
  return result.data;
}

export function parseQuery<T extends ZodTypeAny>(schema: T, request: FastifyRequest): z.infer<T> {
  const result = schema.safeParse(request.query);
  if (!result.success) {
    throw badRequest("query: " + result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "));
  }
  return result.data;
}

export function ok(reply: FastifyReply, data: unknown, status = 200): FastifyReply {
  return reply.status(status).send({ data });
}

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function paginate<T>(rows: T[], q: { limit: number; offset: number }): { items: T[]; total: number } {
  return { items: rows.slice(q.offset, q.offset + q.limit), total: rows.length };
}
