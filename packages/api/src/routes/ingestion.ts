import { z } from "zod";
import { newId, signPostback, verifyUnsubscribeToken, type PostbackPayload } from "@affiliate/core";
import type { Suppression } from "@affiliate/db";
import type { RouteModule } from "./helpers.js";
import { parseBody, ok } from "./helpers.js";
import { requireMerchant } from "../auth/middleware.js";
import { badRequest, notFound } from "../errors.js";
import { ingestOrder, mintClickId, writeClick, resolveTrackingCode } from "../services/tracking.js";
import { reverseOrder } from "../services/reversal.js";
import { resolveUnsubscribeSecret } from "@affiliate/core";
import { appliesGlobally } from "@affiliate/recruitment";

/** A one-click body is a few dozen bytes; anything bigger is not an unsubscribe. */
const UNSUBSCRIBE_BODY_LIMIT = 16 * 1024;

export const ingestionRoutes: RouteModule = (app, ctx) => {
  // ---- Public one-click unsubscribe (the link in every outreach email) ------
  // Honored globally across all merchants, per CAN-SPAM / bulk-sender rules. HARDENED:
  //  - the link is HMAC-signed (m + e + t) — unsigned requests are rejected, so nobody can
  //    suppress arbitrary addresses by enumerating `?e=` (a competitor could otherwise wipe
  //    a merchant's whole prospect list);
  //  - GET renders a CONFIRM page (mail-scanner link prefetchers must never unsubscribe
  //    someone who didn't click); the actual suppression happens on POST — which is also
  //    exactly what the RFC 8058 one-click button sends;
  //  - the merchant id is recorded on the suppression row so unsubscribes attribute.
  // The signing secret is resolved by the SAME helper the recruitment engine signs with
  // (UNSUBSCRIBE_SECRET → JWT_SECRET; present-but-empty counts as unset).
  const unsubSecret = () => resolveUnsubscribeSecret();
  const queryString = (value: unknown): string => (typeof value === "string" ? value : "");
  const unsubParams = (request: { query: unknown }) => {
    const q = (request.query ?? {}) as { e?: unknown; m?: unknown; t?: unknown };
    return { email: queryString(q.e).toLowerCase().trim(), merchantId: queryString(q.m), token: queryString(q.t) };
  };
  const escapeHtml = (text: string): string =>
    text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  const doUnsubscribe = async (email: string, merchantId: string): Promise<boolean> => {
    if (!email || !email.includes("@")) return false;
    const existing = await ctx.db.suppressions.findOne((s) => appliesGlobally(s) && s.email?.toLowerCase() === email);
    if (!existing) {
      const supp: Suppression = {
        id: newId("supp"),
        merchantId: merchantId || null, // attribution only — the suppression still applies globally
        email,
        domain: null,
        reason: "unsubscribe",
        scope: "global",
        origin: "system", // the signed link is one of the two paths allowed to suppress for everyone
        ts: ctx.clock.now().toISOString(),
      };
      await ctx.db.suppressions.insert(supp);
    }
    const prospects = await ctx.db.prospects.find((p) => p.email?.toLowerCase() === email);
    for (const p of prospects) await ctx.db.prospects.update(p.id, { state: "suppressed", suppressionStatus: "suppressed" });
    return true;
  };

  // These two routes live in their own encapsulated scope so that THEY ALONE accept any
  // request body. Real clients never post JSON here: the confirm page's form submits an
  // empty `application/x-www-form-urlencoded` body, and a mailbox provider's RFC 8058
  // one-click button posts `List-Unsubscribe=One-Click` as urlencoded or
  // `multipart/form-data` — all of which the app-wide JSON-only parser answers with 415,
  // i.e. nobody gets unsubscribed. Everything the handler needs is in the signed query
  // string, so the body is read (bounded) and discarded; no other route's parsing changes.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string", bodyLimit: UNSUBSCRIBE_BODY_LIMIT }, (_request, _body, done) => done(null, undefined));

    scope.get("/track/unsubscribe", async (request, reply) => {
      const { email, merchantId, token } = unsubParams(request);
      if (!verifyUnsubscribeToken(merchantId, email, token, unsubSecret())) {
        return reply.code(400).type("text/html").send("<p>Invalid unsubscribe link.</p>");
      }
      // Confirm page — a human clicks the button; a prefetcher fetching this URL changes
      // nothing. The form posts back to this same path (a query-only action), so it keeps
      // working when the API is served under a path prefix.
      return reply.type("text/html").send(
        `<!doctype html><meta name="robots" content="noindex"><div style="font-family:sans-serif;max-width:420px;margin:80px auto;text-align:center">` +
          `<p>Unsubscribe <strong>${escapeHtml(email)}</strong> from these emails?</p>` +
          `<form method="POST" action="?m=${encodeURIComponent(merchantId)}&amp;e=${encodeURIComponent(email)}&amp;t=${encodeURIComponent(token)}">` +
          `<button type="submit" style="padding:10px 22px;font-size:15px;cursor:pointer">Unsubscribe</button></form></div>`,
      );
    });

    // RFC 8058 one-click POST (the mailbox's button) + the confirm form above land here.
    scope.post("/track/unsubscribe", async (request, reply) => {
      const { email, merchantId, token } = unsubParams(request);
      if (!verifyUnsubscribeToken(merchantId, email, token, unsubSecret())) return reply.code(400).send();
      await doUnsubscribe(email, merchantId);
      return reply.type("text/html").send("<p>You've been unsubscribed. You won't receive further emails.</p>");
    });
  });

  // ---- Public signed S2S postback (Section 6) -------------------------------
  // The robust conversion path: HMAC-signed with the per-merchant secret.
  //
  // The body is checked against a schema BEFORE anything else happens — it is a public
  // endpoint and nothing may be written from a malformed body. (`amountCents: 1999.5` used
  // to be stored as an order and a conversion before the money code threw; the corrected
  // retry was then a "duplicate" and the commission was never written.) No field is
  // transformed: the signature covers the values exactly as sent.
  const postbackSchema = z.object({
    merchantId: z.string().min(1).max(200),
    txnId: z.string().min(1).max(200),
    amountCents: z.number().int("must be a whole number of minor units (1999, not 19.99)").min(0).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO-4217 code"),
    clickId: z.string().max(200).nullish(),
    couponCodes: z.array(z.string().max(100)).max(50).optional(),
    customerRef: z.string().max(200).nullish(),
    ts: z.number().int("must be a Unix time in whole seconds").positive(),
  });

  app.post("/track/postback/:merchantId", async (request, reply) => {
    const merchantId = (request.params as { merchantId: string }).merchantId;
    const body = parseBody(postbackSchema, request);
    if (body.merchantId !== merchantId) throw badRequest("validation: merchantId does not match the postback URL");
    const merchant = await ctx.db.merchants.get(merchantId);
    if (!merchant) throw notFound("merchant");
    const signature = (request.headers["x-affiliate-signature"] as string) ?? null;
    // A bad or missing signature is a 401 (PostbackVerificationError), never a 500.
    const result = await ingestOrder(ctx, "s2s", {
      merchantId,
      raw: body,
      signature,
      secret: merchant.postbackSecret,
    });
    return ok(reply, result, result.status === "rejected" ? 422 : 200);
  });

  // ---- Authenticated ingestion for connected integrations -------------------
  app.post("/ingest/:source", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const source = (request.params as { source: string }).source;
    if (!["shopify", "woocommerce", "stripe", "s2s"].includes(source)) throw badRequest("unknown source");
    const merchant = await ctx.db.merchants.require(merchantId);
    const result = await ingestOrder(ctx, source, {
      merchantId,
      raw: request.body,
      signature: (request.headers["x-affiliate-signature"] as string) ?? null,
      secret: merchant.postbackSecret,
    });
    return ok(reply, result);
  });

  // ---- Click capture (off-edge fallback / SDK) ------------------------------
  app.post("/track/click", async (request, reply) => {
    const body = parseBody(
      z.object({
        code: z.string(),
        ip: z.string().nullish(),
        ua: z.string().nullish(),
        landingUrl: z.string().nullish(),
        sub1: z.string().optional(),
        sub2: z.string().optional(),
      }),
      request,
    );
    const resolved = await resolveTrackingCode(ctx, body.code);
    if (!resolved) throw badRequest("unknown tracking code");
    const clickId = mintClickId();
    await writeClick(ctx, clickId, {
      ...resolved,
      ip: body.ip ?? null,
      ua: body.ua ?? null,
      landingUrl: body.landingUrl ?? null,
      ...(body.sub1 ? { sub1: body.sub1 } : {}),
      ...(body.sub2 ? { sub2: body.sub2 } : {}),
    });
    return ok(reply, { clickId });
  });

  // ---- Validation/test tool (Section 6) -------------------------------------
  // Lets a merchant confirm conversions fire before going live; returns the
  // signature they should send so they can wire their checkout.
  app.post("/track/test-postback", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "write");
    const merchant = await ctx.db.merchants.require(merchantId);
    const body = parseBody(
      z.object({
        txnId: z.string(),
        amountCents: z.number().int().positive(),
        currency: z.string().length(3).default("USD"),
        clickId: z.string().nullish(),
        couponCodes: z.array(z.string()).default([]),
      }),
      request,
    );
    const payload: PostbackPayload = {
      merchantId,
      txnId: body.txnId,
      amountCents: body.amountCents,
      currency: body.currency,
      clickId: body.clickId ?? null,
      couponCodes: body.couponCodes,
      customerRef: null,
      ts: Math.floor(ctx.clock.now().getTime() / 1000),
    };
    const signature = signPostback(payload, merchant.postbackSecret);
    const result = await ingestOrder(ctx, "s2s", { merchantId, raw: payload, signature, secret: merchant.postbackSecret });
    return ok(reply, { signature, result, exampleHeader: { "x-affiliate-signature": signature } });
  });

  // ---- Refund / clawback ----------------------------------------------------
  app.post("/orders/:orderId/refund", async (request, reply) => {
    const { merchantId } = await requireMerchant(ctx, request, "approve");
    const orderId = (request.params as { orderId: string }).orderId;
    const order = await ctx.db.orders.get(orderId);
    if (!order || order.merchantId !== merchantId) throw notFound("order");
    const body = parseBody(z.object({ reason: z.string().default("refund") }), request);
    const result = await reverseOrder(ctx, orderId, body.reason);
    if (!result) throw notFound("no reversible conversion for order");
    return ok(reply, result);
  });
};
