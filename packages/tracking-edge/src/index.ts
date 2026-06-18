export * from "./handler.js";
export { DbLinkResolver, DbClickSink } from "./adapters.js";
export { createEdgeServer } from "./server.js";

import type { ResolvedLink } from "./handler.js";

/**
 * Build the link code + KV value the backend syncs to Cloudflare Workers KV so the
 * edge can resolve a redirect without touching the origin.
 */
export function linkCode(affiliateId: string, offerId: string): string {
  return `${affiliateId}.${offerId}`;
}

export function kvEntryForLink(link: ResolvedLink): { key: string; value: string } {
  return { key: linkCode(link.affiliateId, link.offerId), value: JSON.stringify(link) };
}
