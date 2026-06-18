import { z } from "zod";
import { newId } from "@affiliate/core";
import type { AffiliateNote, AffiliateTask, AffiliateMessage } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant, requirePrincipal } from "../auth/middleware.js";
import { notFound } from "../errors.js";

const noteSchema = z.object({
  body: z.string().min(1),
});

const taskSchema = z.object({
  title: z.string().min(1),
  dueAt: z.string().nullish(),
});

const taskPatchSchema = z.object({
  status: z.enum(["open", "done"]).optional(),
  title: z.string().min(1).optional(),
  dueAt: z.string().nullish(),
});

const messageSchema = z.object({
  direction: z.enum(["inbound", "outbound"]),
  channel: z.enum(["email", "in_app", "other"]),
  subject: z.string().nullish(),
  bodyRef: z.string().min(1),
});

export const crmRoutes: RouteModule = (app, ctx) => {
  // ---- Notes ----------------------------------------------------------------
  app.get("/affiliates/:relationshipId/notes", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const notes = await ctx.db.affiliateNotes.find((n) => n.relationshipId === relationshipId);
    return ok(reply, notes);
  });

  app.post("/affiliates/:relationshipId/notes", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const body = parseBody(noteSchema, request);
    const note: AffiliateNote = {
      id: newId("note"),
      relationshipId,
      authorId: requirePrincipal(request).userId ?? "system",
      body: body.body,
      ts: ctx.clock.now().toISOString(),
    };
    await ctx.db.affiliateNotes.insert(note);
    return ok(reply, note, 201);
  });

  // ---- Tasks ----------------------------------------------------------------
  app.get("/affiliates/:relationshipId/tasks", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const tasks = await ctx.db.affiliateTasks.find((t) => t.relationshipId === relationshipId);
    return ok(reply, tasks);
  });

  app.post("/affiliates/:relationshipId/tasks", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const body = parseBody(taskSchema, request);
    const task: AffiliateTask = {
      id: newId("task"),
      relationshipId,
      ownerUserId: requirePrincipal(request).userId ?? "system",
      title: body.title,
      dueAt: body.dueAt ?? null,
      status: "open",
    };
    await ctx.db.affiliateTasks.insert(task);
    return ok(reply, task, 201);
  });

  app.patch("/tasks/:taskId", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const taskId = (request.params as { taskId: string }).taskId;
    const task = await ctx.db.affiliateTasks.get(taskId);
    if (!task) throw notFound("task");
    const relationship = await ctx.db.relationships.get(task.relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("task");
    const body = parseBody(taskPatchSchema, request);
    const patch: Partial<AffiliateTask> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.title !== undefined) patch.title = body.title;
    if (body.dueAt !== undefined) patch.dueAt = body.dueAt ?? null;
    const updated = await ctx.db.affiliateTasks.update(taskId, patch);
    return ok(reply, updated);
  });

  // ---- Messages -------------------------------------------------------------
  app.get("/affiliates/:relationshipId/messages", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "read");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const messages = await ctx.db.affiliateMessages.find((m) => m.relationshipId === relationshipId);
    return ok(reply, messages);
  });

  app.post("/affiliates/:relationshipId/messages", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const relationshipId = (request.params as { relationshipId: string }).relationshipId;
    const relationship = await ctx.db.relationships.get(relationshipId);
    if (!relationship || relationship.merchantId !== merchantId) throw notFound("relationship");
    const body = parseBody(messageSchema, request);
    const message: AffiliateMessage = {
      id: newId("msg"),
      relationshipId,
      direction: body.direction,
      channel: body.channel,
      subject: body.subject ?? null,
      bodyRef: body.bodyRef,
      ts: ctx.clock.now().toISOString(),
    };
    await ctx.db.affiliateMessages.insert(message);
    return ok(reply, message, 201);
  });
};
