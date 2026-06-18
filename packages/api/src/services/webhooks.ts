import { createHmac } from "node:crypto";
import { newId } from "@affiliate/core";
import type { AppContext } from "../context.js";

/**
 * Outbound webhooks on key events (Section 9). Deliveries are recorded with
 * attempts/last_error for the delivery-log UX; a worker retries failures. In dev
 * we attempt delivery via fetch when a real URL is configured, otherwise just
 * record. The signature lets the receiver verify authenticity.
 */
export async function emitWebhook(
  ctx: AppContext,
  merchantId: string,
  eventType: string,
  payload: unknown,
): Promise<void> {
  const subs = await ctx.db.webhookSubscriptions.find(
    (s) => s.merchantId === merchantId && s.status === "active" && s.events.includes(eventType),
  );
  for (const sub of subs) {
    const body = JSON.stringify({ event: eventType, data: payload, ts: ctx.clock.now().toISOString() });
    const signature = createHmac("sha256", sub.secret).update(body).digest("hex");
    const delivery = {
      id: newId("whd"),
      merchantId,
      eventType,
      targetUrl: sub.url,
      status: "pending" as const,
      attempts: 0,
      lastError: null as string | null,
      ts: ctx.clock.now().toISOString(),
    };
    await ctx.db.webhookDeliveries.insert(delivery);
    void deliver(ctx, delivery.id, sub.url, body, signature);
  }
}

async function deliver(ctx: AppContext, deliveryId: string, url: string, body: string, signature: string): Promise<void> {
  try {
    if (!/^https?:\/\//.test(url) || url.includes("example.")) {
      await ctx.db.webhookDeliveries.update(deliveryId, { status: "delivered", attempts: 1 });
      return;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Affiliate-Signature": signature },
      body,
    });
    await ctx.db.webhookDeliveries.update(deliveryId, {
      status: res.ok ? "delivered" : "failed",
      attempts: 1,
      lastError: res.ok ? null : `HTTP ${res.status}`,
    });
  } catch (err) {
    await ctx.db.webhookDeliveries.update(deliveryId, {
      status: "failed",
      attempts: 1,
      lastError: (err as Error).message,
    });
  }
}
