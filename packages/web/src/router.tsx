import { useEffect, useState } from "react";

/** The route path from the current hash, minus any `?query` (e.g. an OAuth callback's
 *  `?connected=…`). Pages that need those params read them with `hashParam`. */
function currentPath(): string {
  return (window.location.hash.slice(1) || "/").split("?")[0] || "/";
}

/**
 * One query parameter from the hash route (`#/portal/verify?token=…` → `hashParam("token")`).
 * Parsed by hand rather than with URLSearchParams so a `+` in a token survives (form
 * decoding would turn it into a space), and a malformed escape returns the raw text
 * instead of throwing.
 */
export function hashParam(name: string, hash: string = window.location.hash): string | null {
  const qi = hash.indexOf("?");
  if (qi === -1) return null;
  for (const pair of hash.slice(qi + 1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    if (safeDecode(rawKey) !== name) continue;
    const value = eq === -1 ? "" : safeDecode(pair.slice(eq + 1));
    return value;
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function toHash(to: string): string {
  return to.startsWith("#") ? to : `#${to}`;
}

/** Minimal dependency-free hash router. Paths look like #/affiliates/:id. */
export function useHashRoute(): { path: string; navigate: (to: string, opts?: NavigateOptions) => void } {
  const [hash, setHash] = useState(currentPath);
  useEffect(() => {
    const onChange = () => setHash(currentPath());
    window.addEventListener("hashchange", onChange);
    // The hash can change between the first render and this effect (a redirect fired
    // from another effect) — resync so that change is not missed.
    onChange();
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return { path: hash, navigate };
}

export interface NavigateOptions {
  /** Replace the current history entry instead of pushing one — for redirects, so Back
   *  does not bounce the visitor straight into the same redirect (or onto a spent link). */
  replace?: boolean;
}

export function navigate(to: string, opts: NavigateOptions = {}): void {
  const hash = toHash(to);
  if (opts.replace) {
    // A fragment-only location.replace swaps the history entry and still fires hashchange.
    window.location.replace(hash);
  } else {
    window.location.hash = hash;
  }
}

/** Match a route pattern like "/affiliates/:id" against the current path. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split("/").filter(Boolean);
  const cp = path.split("/").filter(Boolean);
  if (pp.length !== cp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]!;
    if (seg.startsWith(":")) params[seg.slice(1)] = safeDecode(cp[i]!);
    else if (seg !== cp[i]) return null;
  }
  return params;
}

export function Link({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={`#${to}`}
      className={className}
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
