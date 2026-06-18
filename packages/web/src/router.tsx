import { useEffect, useState } from "react";

/** Minimal dependency-free hash router. Paths look like #/affiliates/:id. */
export function useHashRoute(): { path: string; navigate: (to: string) => void } {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return {
    path: hash,
    navigate: (to: string) => {
      window.location.hash = to.startsWith("#") ? to : `#${to}`;
    },
  };
}

export function navigate(to: string): void {
  window.location.hash = to.startsWith("#") ? to : `#${to}`;
}

/** Match a route pattern like "/affiliates/:id" against the current path. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split("/").filter(Boolean);
  const cp = path.split("/").filter(Boolean);
  if (pp.length !== cp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]!;
    if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(cp[i]!);
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
