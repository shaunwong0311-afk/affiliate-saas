import type { Click, Database } from "@affiliate/db";
import type { ClickRecord, ClickSink, LinkResolver, ResolvedLink } from "./handler.js";

/**
 * Origin-side adapters (the Hetzner path / demo): resolve links and write clicks
 * straight against the Database port. In the Cloudflare deployment the resolver
 * reads Workers KV and the sink enqueues onto a Queue the pipeline drains
 * (see worker.ts) — same interfaces, different bindings.
 */

export class DbLinkResolver implements LinkResolver {
  constructor(
    private readonly db: Database,
    private readonly opts: { defaultDestination?: string } = {},
  ) {}

  /**
   * A link resolves only while it can earn — the same three checks attribution makes, so
   * the edge never records a click that the pipeline would then refuse to credit:
   *  - the offer is active (a paused offer used to keep redirecting);
   *  - the affiliate is not paused or banned;
   *  - the affiliate has an ACTIVE relationship in THIS offer's program (any relationship
   *    with the merchant used to do, including one in a different program).
   */
  async resolve(code: string): Promise<ResolvedLink | null> {
    // Link code convention: `<affiliateId>.<offerId>`.
    const [affiliateId, offerId] = code.split(".");
    if (!affiliateId || !offerId) return null;
    const offer = await this.db.offers.get(offerId);
    if (!offer || offer.status !== "active") return null;
    const affiliate = await this.db.affiliates.get(affiliateId);
    if (affiliate && affiliate.status !== "active") return null;
    const relationship = await this.db.relationships.findOne(
      (r) => r.affiliateId === affiliateId && r.programId === offer.programId && r.merchantId === offer.merchantId,
    );
    if (!relationship || relationship.status !== "active") return null;
    return {
      merchantId: offer.merchantId,
      affiliateId,
      offerId,
      destinationUrl: this.opts.defaultDestination ?? "https://example.com/",
    };
  }
}

export class DbClickSink implements ClickSink {
  constructor(private readonly db: Database) {}

  async write(record: ClickRecord): Promise<void> {
    const click: Click = {
      clickId: record.clickId,
      merchantId: record.merchantId,
      affiliateId: record.affiliateId,
      offerId: record.offerId,
      ts: record.ts,
      ip: record.ip,
      ua: record.ua,
      landingUrl: record.landingUrl,
      ...(record.sub.sub1 ? { sub1: record.sub.sub1 } : {}),
      ...(record.sub.sub2 ? { sub2: record.sub.sub2 } : {}),
      ...(record.sub.sub3 ? { sub3: record.sub.sub3 } : {}),
      ...(record.sub.sub4 ? { sub4: record.sub.sub4 } : {}),
      ...(record.sub.sub5 ? { sub5: record.sub.sub5 } : {}),
    };
    await this.db.clicks.upsert(click);
  }
}
