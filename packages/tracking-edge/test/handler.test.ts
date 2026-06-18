import { describe, it, expect } from "vitest";
import { createRedirectHandler, CLICK_COOKIE, type ClickRecord, type ResolvedLink } from "../src/handler.js";

const link: ResolvedLink = {
  merchantId: "m1",
  affiliateId: "aff1",
  offerId: "off1",
  destinationUrl: "https://shop.example/product",
  allowedHosts: ["shop.example"],
};

function makeHandler(resolved: ResolvedLink | null) {
  const writes: ClickRecord[] = [];
  const handler = createRedirectHandler(
    { resolve: async () => resolved },
    { write: async (c) => void writes.push(c) },
  );
  return { handler, writes };
}

async function runDeferred(defer: Promise<unknown>[]) {
  await Promise.allSettled(defer);
}

describe("redirect hot path", () => {
  it("302s with a click_id appended and sets the cookie", async () => {
    const { handler, writes } = makeHandler(link);
    const deferred: Promise<unknown>[] = [];
    const decision = await handler({
      code: "aff1.off1",
      url: new URL("https://track.you.com/c/aff1.off1"),
      ip: "1.2.3.4",
      ua: "test-agent",
      defer: (p) => deferred.push(p),
    });
    expect(decision.status).toBe(302);
    expect(decision.location).toContain("https://shop.example/product");
    expect(decision.location).toMatch(/click_id=[0-9a-f-]{36}/);
    expect(decision.setCookie).toContain(`${CLICK_COOKIE}=`);

    await runDeferred(deferred);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.affiliateId).toBe("aff1");
    expect(writes[0]!.ip).toBe("1.2.3.4");
  });

  it("honors a validated ?to= deep link", async () => {
    const { handler } = makeHandler(link);
    const decision = await handler({
      code: "aff1.off1",
      url: new URL("https://track.you.com/c/aff1.off1?to=https://shop.example/deep/page"),
      ip: null,
      ua: null,
      defer: () => {},
    });
    expect(decision.location).toContain("/deep/page");
  });

  it("rejects an off-allowlist ?to= (open-redirect guard)", async () => {
    const { handler } = makeHandler(link);
    const decision = await handler({
      code: "aff1.off1",
      url: new URL("https://track.you.com/c/aff1.off1?to=https://evil.example/phish"),
      ip: null,
      ua: null,
      defer: () => {},
    });
    expect(decision.location).toContain("https://shop.example/product");
    expect(decision.location).not.toContain("evil.example");
  });

  it("404s an unknown link", async () => {
    const { handler } = makeHandler(null);
    const decision = await handler({
      code: "nope",
      url: new URL("https://track.you.com/c/nope"),
      ip: null,
      ua: null,
      defer: () => {},
    });
    expect(decision.status).toBe(404);
  });

  it("captures sub-params", async () => {
    const { handler, writes } = makeHandler(link);
    const deferred: Promise<unknown>[] = [];
    await handler({
      code: "aff1.off1",
      url: new URL("https://track.you.com/c/aff1.off1?sub1=youtube&sub2=video42"),
      ip: null,
      ua: null,
      defer: (p) => deferred.push(p),
    });
    await runDeferred(deferred);
    expect(writes[0]!.sub).toEqual({ sub1: "youtube", sub2: "video42" });
  });
});
