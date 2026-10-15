import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createContext, type AppContext } from "../src/context.js";
import { createWebhookSender, emitWebhook, flushWebhookDeliveries, isPublicWebhookUrl, sendWebhook, type WebhookSender } from "../src/services/webhooks.js";

/**
 * AUDIT-2026-10 D9 — outbound webhooks. The target is a URL a tenant typed in. Delivery
 * used to (a) screen only the hostname as written, (b) follow redirects, and (c) record
 * any URL containing "example." as DELIVERED without sending anything.
 */

let ctx: AppContext;
const servers: http.Server[] = [];
beforeEach(() => {
  ctx = createContext();
});
afterEach(async () => {
  await flushWebhookDeliveries();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
});

async function subscribe(url: string, events = ["conversion.created"]) {
  await ctx.db.webhookSubscriptions.insert({ id: `whs_${Math.random().toString(36).slice(2)}`, merchantId: "m1", url, events, secret: "whsec_test", status: "active" });
}
const deliveries = () => ctx.db.webhookDeliveries.find((d) => d.merchantId === "m1");
/** A local server standing in for something INSIDE the network. A hit = the guard failed. */
async function internalService(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (handler) handler(req, res);
    else res.end("ok");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, hits };
}

describe("isPublicWebhookUrl — the creation-time screen", () => {
  it("accepts ordinary public endpoints", () => {
    for (const u of ["https://hooks.customer.com/affiliate", "http://example.com:8443/hook", "https://8.8.8.8/hook"]) expect(isPublicWebhookUrl(u), u).toBe(true);
  });

  it("refuses internal targets in every spelling — not just the ones a regex anticipated", () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data", "http://localhost/hook", "http://127.0.0.1:8787/", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.16.0.9/",
      // These all passed the old hostname-literal check:
      "http://2130706433/", "http://0x7f.0.0.1/", "http://017700000001/", "http://127.1/", "http://0/",
      "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/", "http://[0:0:0:0:0:0:0:1]/", "http://100.64.0.1/", "http://db.lan/", "http://redis:6379/",
      "https://user:pass@hooks.customer.com/", "ftp://hooks.customer.com/", "not a url",
    ]) {
      expect(isPublicWebhookUrl(u), u).toBe(false);
    }
  });
});

describe("delivery goes through the outbound guard", () => {
  it("never records a delivery as delivered without sending it (no 'example.' shortcut)", async () => {
    let sent = 0;
    const sender: WebhookSender = async () => (sent++, { ok: false, error: "HTTP 503" });
    Object.assign(ctx, { webhookSender: sender });
    await subscribe("https://hooks.example.com/affiliate"); // contains "example." — used to be marked delivered, unsent
    await emitWebhook(ctx, "m1", "conversion.created", { conversionId: "c1" });
    await flushWebhookDeliveries();
    expect(sent).toBe(1);
    expect(await deliveries()).toMatchObject([{ status: "failed", attempts: 1, lastError: "HTTP 503", targetUrl: "https://hooks.example.com/affiliate" }]);
  });

  it("signs the exact body it sends, and records success only on the sender's say-so", async () => {
    const seen: { url: string; body: string; headers: Record<string, string> }[] = [];
    Object.assign(ctx, { webhookSender: (async (req) => (seen.push(req), { ok: true })) satisfies WebhookSender });
    await subscribe("https://hooks.customer.com/a");
    await subscribe("https://hooks.customer.com/other-event", ["payout.paid"]); // not subscribed to this event
    await emitWebhook(ctx, "m1", "conversion.created", { conversionId: "c1" });
    await flushWebhookDeliveries();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://hooks.customer.com/a");
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ event: "conversion.created", data: { conversionId: "c1" } });
    expect(seen[0]!.headers["X-Affiliate-Signature"]).toBe(createHmac("sha256", "whsec_test").update(seen[0]!.body).digest("hex"));
    expect(await deliveries()).toMatchObject([{ status: "delivered", attempts: 1, lastError: null }]);
  });

  it("the REAL sender refuses a private target and makes no request", async () => {
    const internal = await internalService();
    for (const url of [`http://127.0.0.1:${internal.port}/admin`, `http://localhost:${internal.port}/admin`, `http://2130706433:${internal.port}/admin`, `http://[::ffff:127.0.0.1]:${internal.port}/admin`]) {
      const r = await sendWebhook({ url, body: "{}", headers: { "Content-Type": "application/json" } });
      expect(r.ok, url).toBe(false);
      expect(r.error, url).toMatch(/^blocked: /);
    }
    expect(internal.hits).toEqual([]);
  });

  it("end to end with the real sender: a subscription pointing inside the network is recorded as blocked", async () => {
    const internal = await internalService();
    // (Rows like this can exist: the creation check is a courtesy, and PATCH does not re-run it.)
    await subscribe(`http://127.0.0.1:${internal.port}/internal-admin`);
    await subscribe("http://169.254.169.254/latest/meta-data/iam/security-credentials/");
    await emitWebhook(ctx, "m1", "conversion.created", { conversionId: "c1" });
    await flushWebhookDeliveries();
    const rows = await deliveries();
    expect(rows).toHaveLength(2);
    for (const d of rows) {
      expect(d.status).toBe("failed");
      expect(d.lastError).toMatch(/^blocked: /);
    }
    expect(internal.hits).toEqual([]);
  });

  it("delivers a real POST to a (test-policy) public receiver and treats only 2xx as delivered", async () => {
    // The guard's test seam: `receiver.test` resolves to the local server and loopback counts as public.
    const lookup = async () => [{ address: "127.0.0.1", family: 4 as const }];
    const send = createWebhookSender({ lookup, isAllowedAddress: (a) => a === "127.0.0.1" });
    const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const receiver = await internalService((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        got.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(req.url === "/down" ? 500 : 204).end();
      });
    });
    const headers = { "Content-Type": "application/json", "X-Affiliate-Signature": "abc123" };
    expect(await send({ url: `http://receiver.test:${receiver.port}/hook`, body: '{"event":"x"}', headers })).toEqual({ ok: true });
    expect(got[0]).toMatchObject({ body: '{"event":"x"}', headers: { "content-type": "application/json", "x-affiliate-signature": "abc123", host: `receiver.test:${receiver.port}` } });
    expect(await send({ url: `http://receiver.test:${receiver.port}/down`, body: "{}", headers })).toEqual({ ok: false, error: "HTTP 500" });
  });

  it("does NOT follow a redirect — a public receiver cannot bounce the signed payload elsewhere", async () => {
    const lookup = async () => [{ address: "127.0.0.1", family: 4 as const }];
    const send = createWebhookSender({ lookup, isAllowedAddress: (a) => a === "127.0.0.1" });
    const target = await internalService();
    const receiver = await internalService((_req, res) => void res.writeHead(307, { location: `http://receiver.test:${target.port}/collect` }).end());
    const r = await send({ url: `http://receiver.test:${receiver.port}/hook`, body: '{"secret":"payload"}', headers: {} });
    expect(r).toEqual({ ok: false, error: "HTTP 307 (redirects are not followed)" });
    expect(receiver.hits).toEqual(["POST /hook"]);
    expect(target.hits).toEqual([]); // the old code followed it (and would have re-POSTed on a 307)
  });

  it("gives up on a receiver that never answers", async () => {
    const lookup = async () => [{ address: "127.0.0.1", family: 4 as const }];
    const silent = await internalService(() => {
      /* never answers */
    });
    const r = await createWebhookSender({ lookup, isAllowedAddress: (a) => a === "127.0.0.1", timeoutMs: 150 })({ url: `http://receiver.test:${silent.port}/hook`, body: "{}", headers: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/150 ms/);
  });

  it("a sender that throws is recorded as a failed delivery, not an unhandled rejection", async () => {
    Object.assign(ctx, { webhookSender: (async () => { throw new Error("socket hang up"); }) satisfies WebhookSender });
    await subscribe("https://hooks.customer.com/a");
    await emitWebhook(ctx, "m1", "conversion.created", {});
    await flushWebhookDeliveries();
    expect(await deliveries()).toMatchObject([{ status: "failed", lastError: "socket hang up" }]);
  });

  it("emitWebhook does not wait for the receiver", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    Object.assign(ctx, { webhookSender: (async () => (await gate, { ok: true })) satisfies WebhookSender });
    await subscribe("https://hooks.customer.com/slow");
    await emitWebhook(ctx, "m1", "conversion.created", {}); // returns while the receiver is still "thinking"
    expect((await deliveries())[0]!.status).toBe("pending");
    release();
    await flushWebhookDeliveries();
    expect((await deliveries())[0]!.status).toBe("delivered");
  });
});
