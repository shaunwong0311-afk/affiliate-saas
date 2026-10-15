import { ProxyUnavailableError, type FetchResult, type HttpFetcher } from "./http.js";
import { assertPublicUrl, UnsafeUrlError, type GuardPolicy } from "./net-guard.js";

/**
 * Headless-browser fetching (Section 8.1) — for JS-rendered pages and to pass the
 * JavaScript challenges that anti-bot layers (Cloudflare "checking your browser",
 * etc.) throw at raw fetch. Real browser = real fingerprint + JS execution, so a lot
 * of soft bot-walls resolve on their own. Playwright is an OPTIONAL dependency,
 * dynamically imported (same pattern as undici in http.ts) so the package installs
 * and tests run without it; to enable: `npm install playwright && npx playwright
 * install chromium`. A CAPTCHA wall (Turnstile/hCaptcha) is NOT solved here — that
 * needs residential proxies to avoid the challenge, or a managed unblocker API behind
 * this same port. When a page can't be obtained we return a non-2xx result and the
 * pipeline records no data (never fabricates).
 */

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const MAX_HTML_CHARS = 2_000_000;

/**
 * Playwright wants proxy credentials as separate fields; a `user:pass@` embedded in the
 * `server` URL is not applied (the proxy then answers 407 to every request). Split them.
 * UNVALIDATED against a live proxy (AUDIT-2026-10 D16) — Playwright is not installed
 * here; the shape follows its documented `proxy: { server, username, password }` option.
 */
function playwrightProxy(proxyUrl: string): { server: string; username?: string; password?: string } {
  try {
    const u = new URL(proxyUrl);
    const server = `${u.protocol}//${u.host}`;
    return u.username
      ? { server, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
      : { server };
  } catch {
    return { server: proxyUrl };
  }
}

export interface PlaywrightFetcherOptions extends GuardPolicy {
  proxies?: string[];
  timeoutMs?: number;
  headless?: boolean;
  /** Loads the `playwright` package. Default: a dynamic import. Injected in tests. */
  loadPlaywright?: () => Promise<any>;
}

export class PlaywrightFetcher implements HttpFetcher {
  readonly kind = "playwright";
  private browserP: Promise<unknown> | null = null;
  private proxyI = 0;
  constructor(private readonly opts: PlaywrightFetcherOptions = {}) {}

  private launch(): Promise<any> {
    if (!this.browserP) {
      this.browserP = (async () => {
        const load = this.opts.loadPlaywright ?? (() => import("playwright" as string));
        const pw: any = await load().catch(() => {
          throw new Error("playwright not installed — run `npm install playwright && npx playwright install chromium`");
        });
        return pw.chromium.launch({ headless: this.opts.headless ?? true });
      })().catch((e) => {
        this.browserP = null; // don't cache a failed launch
        throw e;
      });
    }
    return this.browserP as Promise<any>;
  }

  async get(url: string): Promise<FetchResult> {
    let context: any;
    // One verdict per host for the life of this page load (a page makes many requests).
    const verdicts = new Map<string, Promise<boolean>>();
    const isSafe = (target: string): Promise<boolean> => {
      let u: URL;
      try {
        u = new URL(target);
      } catch {
        return Promise.resolve(false);
      }
      // Inline content never leaves the process; anything else must be http(s) to a public host.
      if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return Promise.resolve(true);
      const key = `${u.protocol}//${u.host}`;
      let verdict = verdicts.get(key);
      if (!verdict) {
        verdict = assertPublicUrl(u, this.opts).then(
          () => true,
          () => false,
        );
        verdicts.set(key, verdict);
      }
      return verdict;
    };

    try {
      // The outbound guard applies to the browser too: refuse BEFORE launching anything.
      if (!(await isSafe(url))) return { status: 0, url, html: "" };
      const browser = await this.launch();
      // Per-context proxy rotation + a realistic fingerprint (UA / viewport / locale).
      const proxy = this.opts.proxies?.length ? playwrightProxy(this.opts.proxies[this.proxyI++ % this.opts.proxies.length]!) : undefined;
      context = await browser.newContext({
        userAgent: BROWSER_UA,
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        proxy,
        serviceWorkers: "block", // a service worker would answer requests behind the route handler
      });
      // Screen every request the page starts — navigations, frames, scripts, XHR.
      await context.route("**/*", async (route: any) => {
        if (await isSafe(route.request().url())) await route.continue();
        else await route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.opts.timeoutMs ?? 25000 });
      // Give a JS challenge (Cloudflare interstitial, lazy content) a beat to settle.
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

      // KNOWN GAP: Playwright calls a route handler only for the FIRST url of a redirect
      // chain, so a server-side redirect is followed by the browser unscreened. We re-check
      // the main document's whole chain here and DISCARD the page if any hop was not a
      // public destination — which stops the response being used, but not the request
      // having been made. Run BROWSER_FETCH with PROXY_URL set (the browser then egresses
      // via the proxy, not this network) or in an egress-restricted container.
      const chain: string[] = [page.url()];
      for (let req = resp?.request?.(); req; req = req.redirectedFrom?.()) chain.push(req.url());
      for (const hop of chain) {
        if (!(await isSafe(hop))) return { status: 0, url, html: "" };
      }

      const html: string = await page.content();
      const truncated = html.length > MAX_HTML_CHARS;
      return { status: resp ? resp.status() : 200, url, finalUrl: page.url(), html: truncated ? html.slice(0, MAX_HTML_CHARS) : html, truncated };
    } catch {
      return { status: 0, url, html: "" }; // unreachable / no playwright → honest miss
    } finally {
      await context?.close?.().catch(() => {});
    }
  }

  /** Close the shared browser (call on shutdown). */
  async close(): Promise<void> {
    try {
      const b: any = await this.browserP;
      await b?.close?.();
    } catch {
      /* nothing to close */
    }
  }
}

/** A fetched page that looks like an anti-bot challenge / block, not real content. */
export function looksBlocked(r: { status: number; html: string }): boolean {
  if (r.status === 403 || r.status === 429 || r.status === 503) return true;
  if (!r.html || r.html.length < 200) return true; // empty/near-empty → likely JS-gated
  return /just a moment|checking your browser|cf-browser-verification|cf[- ]challenge|attention required|enable javascript|recaptcha|hcaptcha|turnstile|are you a human|access denied|ddos protection/i.test(
    r.html,
  );
}

/**
 * Try the CHEAP static fetcher first; only escalate to the (expensive) browser when
 * the result looks blocked/empty/challenged. So we pay the browser cost only when we
 * have to — most creator/affiliate pages come back fine on the static path.
 */
export class EscalatingFetcher implements HttpFetcher {
  readonly kind = "escalating";
  constructor(
    private readonly cheap: HttpFetcher,
    private readonly browser: HttpFetcher,
  ) {}
  async get(url: string): Promise<FetchResult> {
    let r: FetchResult;
    try {
      r = await this.cheap.get(url);
    } catch (err) {
      // A REFUSAL is not a blocked page. A URL the outbound guard rejected, or a fetch
      // that had to go through a proxy that is unavailable, must fail — not be retried
      // through a second fetcher with different egress.
      if (err instanceof UnsafeUrlError || err instanceof ProxyUnavailableError) throw err;
      r = { status: 0, url, html: "" };
    }
    if (!looksBlocked(r)) return r;
    try {
      const viaBrowser = await this.browser.get(url);
      return looksBlocked(viaBrowser) ? r : viaBrowser; // keep whichever is usable
    } catch {
      return r;
    }
  }
}
