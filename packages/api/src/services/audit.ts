import { newId } from "@affiliate/core";
import type { AppContext } from "../context.js";

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
