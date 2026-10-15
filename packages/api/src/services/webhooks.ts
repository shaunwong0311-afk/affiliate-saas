import { createHmac } from "node:crypto";
import { newId } from "@affiliate/core";
import { guardedFetch, unsafeUrlReason, UnsafeUrlError, type GuardPolicy } from "@affiliate/integrations";
import type { AppContext } from "../context.js";

/**
 * Outbound webhooks on key events (Section 9). Deliveries are recorded with
 * attempts/last_error for the delivery-log UX. The signature lets the receiver verify
 * authenticity.
 *
 * A webhook target is a URL a TENANT typed in, and the server will POST to it — so every
 * delivery goes through the outbound guard (`guardedFetch`): the host is resolved and
 * must be a public address, redirects are NOT followed, and the request has a deadline.
 * Nothing is ever recorded as delivered without a 2xx answer from the receiver.
 */

/** One delivery attempt, as the delivery log needs to know it. */
export interface WebhookSendResult {
  ok: boolean;
  /** Recorded as `lastError` when not ok. */
  error?: string;
}

/** Performs one delivery attempt. The default is the guarded network send. */
export type WebhookSender = (request: { url: string; body: string; headers: Record<string, string> }) => Promise<WebhookSendResult>;

const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Build the guarded network sender: a POST that never follows a redirect (a receiver
 * answering 3xx is a failed delivery — following it would let a public URL bounce the
 * signed payload somewhere else) and reads at most a little of the reply. `policy` is
 * the outbound guard's test seam (DNS + which addresses count as public); production
 * uses the defaults.
 */
export function createWebhookSender(policy: GuardPolicy & { timeoutMs?: number } = {}): WebhookSender {
  return async ({ url, body, headers }) => {
    try {
      const res = await guardedFetch(url, {
        method: "POST",
        headers,
        body,
        maxRedirects: 0,
        timeoutMs: policy.timeoutMs ?? DELIVERY_TIMEOUT_MS,
        maxBodyBytes: 16_384,
        lookup: policy.lookup,
        isAllowedAddress: policy.isAllowedAddress,
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      const redirected = res.status >= 300 && res.status < 400 ? " (redirects are not followed)" : "";
      return { ok: false, error: `HTTP ${res.status}${redirected}` };
    } catch (err) {
      if (err instanceof UnsafeUrlError) return { ok: false, error: `blocked: ${err.reason}` };
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
  };
}

/** The real sender, with the production guard. */
export const sendWebhook: WebhookSender = createWebhookSender();

// In-flight deliveries. emitWebhook does not make its caller wait on a third party's
// server; this lets tests (and a graceful shutdown) wait for what is still out.
const inflight = new Set<Promise<void>>();

/** Resolve once every delivery started so far has been recorded. */
export async function flushWebhookDeliveries(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

/**
 * The sender for a context. Tests inject one by putting a `webhookSender` on the context
 * object (`Object.assign(ctx, { webhookSender })`) — there is no URL that is "delivered"
 * without being sent.
 */
function senderFor(ctx: AppContext): WebhookSender {
  return (ctx as AppContext & { webhookSender?: WebhookSender }).webhookSender ?? sendWebhook;
}

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
    const task = deliver(ctx, delivery.id, sub.url, body, signature).finally(() => inflight.delete(task));
    inflight.add(task);
  }
}

/**
 * Cheap, synchronous screen for a webhook URL as the tenant types it: http(s), no
 * embedded credentials, and not localhost / an internal name / a private, link-local or
 * metadata IP — in ANY spelling (`http://2130706433/`, `http://[::ffff:127.0.0.1]/`).
 * It does not resolve DNS, so it is a courtesy at creation time, NOT the protection: a
 * public-looking name that points at a private address is refused when the delivery is
 * attempted, where the guard resolves it.
 */
export function isPublicWebhookUrl(raw: string): boolean {
  return unsafeUrlReason(raw) === null;
}

async function deliver(ctx: AppContext, deliveryId: string, url: string, body: string, signature: string): Promise<void> {
  let result: WebhookSendResult;
  try {
    result = await senderFor(ctx)({ url, body, headers: { "Content-Type": "application/json", "X-Affiliate-Signature": signature } });
  } catch (err) {
    result = { ok: false, error: (err as Error)?.message ?? String(err) };
  }
  try {
    await ctx.db.webhookDeliveries.update(deliveryId, {
      status: result.ok ? "delivered" : "failed",
      attempts: 1,
      lastError: result.ok ? null : (result.error ?? "delivery failed"),
    });
  } catch {
    /* the delivery row is gone (store reset) — nothing left to record */
  }
}
