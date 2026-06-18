import { uuidv7 } from "@affiliate/core";

/**
 * The redirect hot path (Section 6), transport-agnostic so the SAME logic runs on
 * Cloudflare Workers in production and as a Node service in the demo/tests.
 *
 * Flow: decode affiliate_id + offer_id from the link (resolved out of Workers KV
 * that the backend syncs), mint a time-sortable click_id (UUIDv7), set a
 * first-party cookie, append click_id to the destination, and 302 IMMEDIATELY.
 * The click record is written ASYNCHRONOUSLY (waitUntil / fire-and-forget) so it
 * never blocks the redirect — sub-50ms globally on edge compute.
 */

export interface ResolvedLink {
  merchantId: string;
  affiliateId: string;
  offerId: string;
  /** Default destination if the link doesn't carry a `?to=` deep link. */
  destinationUrl: string;
  /** Allowed destination hosts for `?to=` deep links (open-redirect guard). */
  allowedHosts?: string[];
}

/** Reads links the backend syncs into the edge (Workers KV in prod). */
export interface LinkResolver {
  resolve(code: string): Promise<ResolvedLink | null>;
}

export interface ClickRecord {
  clickId: string;
  merchantId: string;
  affiliateId: string;
  offerId: string;
  ts: string;
  ip: string | null;
  ua: string | null;
  landingUrl: string | null;
  sub: Record<string, string>;
}

/** Sink for click records — enqueues onto the pipeline's queue in prod. */
export interface ClickSink {
  write(click: ClickRecord): Promise<void>;
}

export interface RedirectInput {
  code: string;
  url: URL;
  ip: string | null;
  ua: string | null;
  /** Schedules async work without blocking the response (Workers waitUntil). */
  defer: (p: Promise<unknown>) => void;
}

export interface RedirectDecision {
  status: number;
  location?: string;
  setCookie?: string;
  body?: string;
}

export const CLICK_COOKIE = "_aff_click";

export function createRedirectHandler(resolver: LinkResolver, sink: ClickSink) {
  return async function handleRedirect(input: RedirectInput): Promise<RedirectDecision> {
    const link = await resolver.resolve(input.code);
    if (!link) {
      return { status: 404, body: "unknown tracking link" };
    }

    const clickId = uuidv7();

    // Resolve the destination: a `?to=` deep link (validated) or the default.
    const to = input.url.searchParams.get("to");
    const destination = safeDestination(to, link) ?? link.destinationUrl;

    const dest = new URL(destination);
    dest.searchParams.set("click_id", clickId);

    // Collect sub-params (sub1..sub5) for the click record.
    const sub: Record<string, string> = {};
    for (const k of ["sub1", "sub2", "sub3", "sub4", "sub5"]) {
      const v = input.url.searchParams.get(k);
      if (v) sub[k] = v;
    }

    // Fire-and-forget the click write — never block the redirect.
    input.defer(
      sink.write({
        clickId,
        merchantId: link.merchantId,
        affiliateId: link.affiliateId,
        offerId: link.offerId,
        ts: new Date().toISOString(),
        ip: input.ip,
        ua: input.ua,
        landingUrl: dest.toString(),
        sub,
      }),
    );

    return {
      status: 302,
      location: dest.toString(),
      setCookie: `${CLICK_COOKIE}=${clickId}; Path=/; Max-Age=2592000; SameSite=Lax`,
    };
  };
}

function safeDestination(to: string | null, link: ResolvedLink): string | null {
  if (!to) return null;
  let url: URL;
  try {
    url = new URL(to);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const allowed = link.allowedHosts;
  if (allowed && allowed.length > 0) {
    const host = url.hostname.replace(/^www\./, "");
    if (!allowed.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  }
  return url.toString();
}
