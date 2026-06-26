import type { FetchResult, HttpFetcher } from "./http.js";

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

export class PlaywrightFetcher implements HttpFetcher {
  readonly kind = "playwright";
  private browserP: Promise<unknown> | null = null;
  private proxyI = 0;
  constructor(private readonly opts: { proxies?: string[]; timeoutMs?: number; headless?: boolean } = {}) {}

  private launch(): Promise<any> {
    if (!this.browserP) {
      this.browserP = (async () => {
        const pw: any = await import("playwright" as string).catch(() => {
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
    try {
      const browser = await this.launch();
      // Per-context proxy rotation + a realistic fingerprint (UA / viewport / locale).
      const proxy = this.opts.proxies?.length ? { server: this.opts.proxies[this.proxyI++ % this.opts.proxies.length]! } : undefined;
      context = await browser.newContext({ userAgent: BROWSER_UA, viewport: { width: 1280, height: 800 }, locale: "en-US", proxy });
      const page = await context.newPage();
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.opts.timeoutMs ?? 25000 });
      // Give a JS challenge (Cloudflare interstitial, lazy content) a beat to settle.
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      const html = await page.content();
      return { status: resp ? resp.status() : 200, url: page.url(), html };
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
    } catch {
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
