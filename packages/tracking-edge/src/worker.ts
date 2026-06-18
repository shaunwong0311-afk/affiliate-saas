import { createRedirectHandler, type ClickRecord, type ClickSink, type LinkResolver, type ResolvedLink } from "./handler.js";

/**
 * Cloudflare Workers entry for the redirect (Section 11 deployment topology).
 * The Worker resolves the link from Workers KV (which the backend syncs), mints
 * the click_id, sets the cookie, 302s immediately, and pushes the click onto a
 * Queue the Hetzner pipeline drains — never touching the origin on the hot path.
 *
 * Minimal local typings stand in for @cloudflare/workers-types so this typechecks
 * in the monorepo without the Workers dependency.
 */
interface KVNamespace {
  get(key: string, type?: "text"): Promise<string | null>;
}
interface Queue<T = unknown> {
  send(message: T): Promise<void>;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
interface Env {
  LINKS: KVNamespace; // KV: code -> ResolvedLink JSON, synced by the backend
  CLICKS: Queue<ClickRecord>; // Queue the pipeline consumes
}

class KvLinkResolver implements LinkResolver {
  constructor(private readonly kv: KVNamespace) {}
  async resolve(code: string): Promise<ResolvedLink | null> {
    const raw = await this.kv.get(code, "text");
    return raw ? (JSON.parse(raw) as ResolvedLink) : null;
  }
}

class QueueClickSink implements ClickSink {
  constructor(private readonly queue: Queue<ClickRecord>) {}
  async write(click: ClickRecord): Promise<void> {
    await this.queue.send(click);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/c\/([^/]+)$/);
    if (!match) return new Response("not found", { status: 404 });

    const handler = createRedirectHandler(new KvLinkResolver(env.LINKS), new QueueClickSink(env.CLICKS));
    const decision = await handler({
      code: decodeURIComponent(match[1]!),
      url,
      ip: request.headers.get("cf-connecting-ip"),
      ua: request.headers.get("user-agent"),
      defer: (p) => ctx.waitUntil(p),
    });

    const headers = new Headers();
    if (decision.location) headers.set("Location", decision.location);
    if (decision.setCookie) headers.set("Set-Cookie", decision.setCookie);
    return new Response(decision.body ?? null, { status: decision.status, headers });
  },
};
