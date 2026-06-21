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

/**
 * SSRF guard: outbound webhooks must target public HTTP(S) endpoints only — never
 * localhost, link-local, cloud metadata, or private ranges. (Hostname-literal
 * screening; a hardened deployment also pins the resolved IP.)
 */
export function isPublicWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  // IPv4 literal in a private / link-local / loopback range.
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return false;
  }
  if (host === "::1" || host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd")) return false;
  return true;
}

async function deliver(ctx: AppContext, deliveryId: string, url: string, body: string, signature: string): Promise<void> {
  try {
    if (url.includes("example.")) {
      await ctx.db.webhookDeliveries.update(deliveryId, { status: "delivered", attempts: 1 });
      return;
    }
    if (!isPublicWebhookUrl(url)) {
      await ctx.db.webhookDeliveries.update(deliveryId, { status: "failed", attempts: 1, lastError: "blocked: non-public webhook target" });
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
