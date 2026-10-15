import { newId } from "@affiliate/core";
import type { AppContext } from "../context.js";
import type { AuthPrincipal } from "../auth/middleware.js";

export async function writeAudit(
  ctx: AppContext,
  params: {
    merchantId: string;
    actorId: string | null;
    action: string;
    subjectType: string;
    subjectId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.db.auditLogs.insert({
    id: newId("audit"),
    merchantId: params.merchantId,
    actorId: params.actorId,
    action: params.action,
    subjectType: params.subjectType,
    subjectId: params.subjectId ?? null,
    metadata: params.metadata ?? {},
    ts: ctx.clock.now().toISOString(),
  });
}

/**
 * Who performed the request, for `writeAudit`'s `actorId`: the signed-in user, else the API
 * key, else null (a public or system path). An audit row without its actor cannot answer
 * the one question it exists for.
 */
export function actorIdOf(request: { principal?: AuthPrincipal }): string | null {
  return request.principal?.userId ?? request.principal?.apiKeyId ?? null;
}
