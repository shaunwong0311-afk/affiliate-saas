import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo as SocketAddress } from "node:net";
import {
  guardedFetch,
  assertPublicUrl,
  assertPublicHost,
  unsafeUrlReason,
  isPublicIp,
  ipBlockReason,
  UnsafeUrlError,
  GuardedFetchError,
  type AddressInfo,
  type GuardedTransport,
} from "../src/index.js";

/**
 * AUDIT-2026-10 D9 / contract 5 — the outbound guard. Everything here is local: servers
 * bind to 127.0.0.x, DNS is injected, and nothing is asked of the real network.
 */

// ---- local servers ----------------------------------------------------------
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
});

interface Hit {
  method: string;
  url: string;
  host: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, hit: Hit) => void, bind = "127.0.0.1") {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const hit: Hit = { method: req.method ?? "", url: req.url ?? "", host: req.headers.host, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      hits.push(hit);
      handler(req, res, hit);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, bind, r));
  return { port: (server.address() as SocketAddress).port, hits };
}

/** DNS for the tests: named hosts → loopback. The policy then decides which loopback is "public". */
const dns = (map: Record<string, string>) => async (host: string): Promise<AddressInfo[]> => {
  const address = map[host];
  if (!address) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return [{ address, family: 4 }];
};
/** Treat 127.0.0.1 as the "public internet" and everything else (incl. 127.0.0.2) as it really is. */
const onlyLoopbackOne = (address: string) => address === "127.0.0.1";

// ---- address classification -----------------------------------------------------
describe("isPublicIp / ipBlockReason", () => {
  it("accepts ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });

  it("rejects private, loopback, link-local, CGNAT, metadata and reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "100.100.100.200", "0.0.0.0", "0.1.2.3",
      "192.0.0.192", "192.0.2.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    expect(ipBlockReason("169.254.169.254")).toMatch(/metadata/);
  });

  it("rejects IPv6 loopback, ULA, link-local, multicast and documentation ranges", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd00:ec2::254", "fdff:ffff::1", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "2001::1", "100::1", "[::1]"]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it("looks INSIDE IPv6 addresses that wrap an IPv4 one (mapped, compatible, NAT64, 6to4)", () => {
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::ffff:192.168.0.1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::", "2002:a9fe:a9fe::1"]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    // …and does not over-block: a NAT64 / mapped PUBLIC address is still public.
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicIp("64:ff9b::808:808")).toBe(true);
    expect(ipBlockReason("::ffff:169.254.169.254")).toMatch(/169\.254\.169\.254/);
  });

  it("refuses anything that is not an IP address at all", () => {
    for (const s of ["", "localhost", "example.com", "999.1.1.1", "1.2.3", "::gggg"]) expect(isPublicIp(s), s).toBe(false);
  });
});

// ---- URL screening (no network) ---------------------------------------------------
describe("unsafeUrlReason — the synchronous screen", () => {
  it("passes ordinary public URLs", () => {
    for (const u of ["https://example.com/", "http://sub.example.co.uk:8080/path?q=1", "https://8.8.8.8/", "https://[2606:4700:4700::1111]/"]) {
      expect(unsafeUrlReason(u), u).toBeNull();
    }
  });

  it("refuses private addresses in EVERY spelling", () => {
    for (const u of [
      "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://0x7f.1/", "http://017700000001/", "http://127.1/", "http://0/",
      "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[0:0:0:0:0:ffff:7f00:1]/", "http://[fd00:ec2::254]/latest/",
      "http://169.254.169.254/latest/meta-data/", "http://10.1.2.3:6379/", "http://192.168.0.1/admin", "http://100.64.0.1/",
    ]) {
      expect(unsafeUrlReason(u), u).not.toBeNull();
    }
  });

  it("refuses internal names, single-label hosts, other schemes and embedded credentials", () => {
    for (const u of [
      "http://localhost/", "http://LOCALHOST./x", "http://api.localhost/", "http://printer.local/", "http://metadata.google.internal/computeMetadata/v1/",
      "http://db.internal:5432/", "http://postgres:5432/", "http://redis/", "http://intranet.lan/",
      "file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "javascript:alert(1)", "data:text/html,x",
      "https://user:pass@example.com/", "https://admin@example.com/", "not a url", "", "//example.com/",
    ]) {
      expect(unsafeUrlReason(u), u).not.toBeNull();
    }
  });
});

// ---- DNS resolution ---------------------------------------------------------------
describe("assertPublicUrl — resolves, then judges every address", () => {
  it("refuses a public-looking name that resolves to a private address", async () => {
    for (const address of ["127.0.0.1", "10.0.0.7", "169.254.169.254", "192.168.1.10", "100.64.1.1"]) {
      await expect(assertPublicUrl("https://totally-public.example.com/", { lookup: async () => [{ address, family: 4 }] })).rejects.toThrow(UnsafeUrlError);
    }
    await expect(assertPublicUrl("https://v6.example.com/", { lookup: async () => [{ address: "fd00::1", family: 6 }] })).rejects.toThrow(/unique-local/);
  });

  it("refuses when ANY of several addresses is private (the connection could land on it)", async () => {
    const mixed = async (): Promise<AddressInfo[]> => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expect(assertPublicUrl("https://mixed.example.com/", { lookup: mixed })).rejects.toThrow(/10\.0\.0\.5/);
  });

  it("returns the vetted addresses for a public name, and reports DNS failure as such", async () => {
    const ok = await assertPublicUrl("https://fine.example.com/x", { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    expect(ok.addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertPublicUrl("https://nowhere.example.com/", { lookup: dns({}) })).rejects.toMatchObject({ name: "GuardedFetchError", code: "dns" });
    await expect(assertPublicUrl("https://empty.example.com/", { lookup: async () => [] })).rejects.toMatchObject({ code: "dns" });
  });

  it("assertPublicHost applies the same check to a bare host (a tenant-entered SMTP/IMAP server)", async () => {
    const lookup = async (h: string): Promise<AddressInfo[]> => [{ address: h === "mail.customer.com" ? "93.184.216.34" : "10.0.0.25", family: 4 }];
    expect(await assertPublicHost("mail.customer.com", { lookup })).toEqual([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertPublicHost("smtp.internal-relay.com", { lookup })).rejects.toThrow(UnsafeUrlError);
    for (const host of ["localhost", "127.0.0.1", "169.254.169.254", "::1", "[fd00::1]", "redis", "", "evil.com/path", "user@evil.com"]) {
      await expect(assertPublicHost(host, { lookup }), host).rejects.toThrow(UnsafeUrlError);
    }
  });

  it("never asks DNS about a URL the literal screen already refused", async () => {
    let lookups = 0;
    const lookup = async (): Promise<AddressInfo[]> => (lookups++, [{ address: "93.184.216.34", family: 4 }]);
    await expect(assertPublicUrl("http://127.0.0.1/", { lookup })).rejects.toThrow(UnsafeUrlError);
    await expect(assertPublicUrl("file:///etc/passwd", { lookup })).rejects.toThrow(UnsafeUrlError);
    expect(lookups).toBe(0);
  });
});

// ---- guardedFetch over real local sockets -------------------------------------------
describe("guardedFetch — direct transport", () => {
  it("fetches a page, connecting to the vetted address while keeping the hostname", async () => {
    const site = await serve((_req, res) => res.end("<html>hello</html>"));
    const r = await guardedFetch(`http://site.test:${site.port}/page?x=1`, { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne });
    expect(r).toMatchObject({ status: 200, body: "<html>hello</html>", truncated: false, redirects: [] });
    expect(r.url).toBe(`http://site.test:${site.port}/page?x=1`);
    expect(site.hits).toHaveLength(1);
    expect(site.hits[0]).toMatchObject({ method: "GET", url: "/page?x=1", host: `site.test:${site.port}` }); // Host header = the name, socket = the vetted IP
  });

  it("is refused BEFORE any connection when the name resolves somewhere private (default policy)", async () => {
    const site = await serve((_req, res) => res.end("secret"));
    await expect(guardedFetch(`http://site.test:${site.port}/`, { lookup: dns({ "site.test": "127.0.0.1" }) })).rejects.toThrow(UnsafeUrlError);
    await expect(guardedFetch(`http://127.0.0.1:${site.port}/`)).rejects.toThrow(UnsafeUrlError);
    await expect(guardedFetch(`http://localhost:${site.port}/`)).rejects.toThrow(UnsafeUrlError);
    expect(site.hits).toHaveLength(0);
  });

  it("PINS the connection: DNS is asked once, and a second (rebinding) answer is never used", async () => {
    const site = await serve((_req, res) => res.end("ok"));
    let calls = 0;
    // First answer: the address that gets vetted. Any later answer would point elsewhere.
    const rebinding = async (): Promise<AddressInfo[]> => [{ address: ++calls === 1 ? "127.0.0.1" : "127.0.0.2", family: 4 }];
    const r = await guardedFetch(`http://rebind.test:${site.port}/`, { lookup: rebinding, isAllowedAddress: onlyLoopbackOne });
    expect(r.body).toBe("ok");
    expect(calls).toBe(1);
    expect(site.hits).toHaveLength(1);
  });

  it("follows redirects itself and reports the chain", async () => {
    const site = await serve((req, res) => {
      if (req.url === "/a") return void res.writeHead(302, { location: "/b" }).end();
      if (req.url === "/b") return void res.writeHead(301, { location: `http://other.test:${site.port}/c` }).end();
      res.end("landed");
    });
    const r = await guardedFetch(`http://site.test:${site.port}/a`, { lookup: dns({ "site.test": "127.0.0.1", "other.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne });
    expect(r.body).toBe("landed");
    expect(r.url).toBe(`http://other.test:${site.port}/c`);
    expect(r.redirects).toEqual([`http://site.test:${site.port}/b`, `http://other.test:${site.port}/c`]);
    expect(site.hits.map((h) => h.url)).toEqual(["/a", "/b", "/c"]);
  });

  it("re-checks EVERY redirect hop: a public page cannot bounce the request to a private address", async () => {
    // The "internal service" listens on 127.0.0.2, which the test policy does NOT allow.
    const internal = await serve((_req, res) => res.end("internal secret"), "127.0.0.2");
    for (const target of [`http://127.0.0.2:${internal.port}/secret`, `http://internal.test:${internal.port}/secret`, "http://169.254.169.254/latest/meta-data/", "http://localhost:6379/"]) {
      const site = await serve((_req, res) => void res.writeHead(302, { location: target }).end());
      const attempt = guardedFetch(`http://site.test:${site.port}/go`, {
        lookup: dns({ "site.test": "127.0.0.1", "internal.test": "127.0.0.2" }),
        isAllowedAddress: onlyLoopbackOne,
      });
      await expect(attempt, target).rejects.toThrow(UnsafeUrlError);
      expect(site.hits).toHaveLength(1); // the first hop was made…
    }
    expect(internal.hits).toHaveLength(0); // …the internal one never was
  });

  it("refuses a redirect to a non-http scheme", async () => {
    for (const location of ["file:///etc/passwd", "gopher://127.0.0.1:6379/_INFO", "ftp://example.com/x"]) {
      const site = await serve((_req, res) => void res.writeHead(302, { location }).end());
      await expect(guardedFetch(`http://site.test:${site.port}/`, { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne })).rejects.toThrow(UnsafeUrlError);
    }
  });

  it("stops after maxRedirects, and with maxRedirects 0 hands back the 3xx untouched", async () => {
    const loop = await serve((req, res) => void res.writeHead(302, { location: `/again?n=${Date.now()}${req.url?.length}` }).end());
    const opts = { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne };
    await expect(guardedFetch(`http://site.test:${loop.port}/`, { ...opts, maxRedirects: 3 })).rejects.toMatchObject({ name: "GuardedFetchError", code: "too_many_redirects" });
    expect(loop.hits).toHaveLength(4); // the original + 3 followed

    const once = await serve((_req, res) => void res.writeHead(307, { location: "http://elsewhere.test/" }).end("moved"));
    const r = await guardedFetch(`http://site.test:${once.port}/`, { ...opts, maxRedirects: 0 });
    expect(r.status).toBe(307);
    expect(r.headers.location).toBe("http://elsewhere.test/");
    expect(once.hits).toHaveLength(1);
  });

  it("enforces one deadline for the whole exchange", async () => {
    const silent = await serve(() => {
      /* never answers */
    });
    const started = Date.now();
    await expect(
      guardedFetch(`http://site.test:${silent.port}/`, { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne, timeoutMs: 150 }),
    ).rejects.toMatchObject({ name: "GuardedFetchError", code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);

    // A resolver that hangs is bounded by the same deadline.
    const hung = () => new Promise<AddressInfo[]>(() => {});
    await expect(guardedFetch("http://slow-dns.test/", { lookup: hung, timeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" });

    // …and a body that trickles for ever does not get to hold the connection open.
    const trickle = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html>");
    });
    await expect(
      guardedFetch(`http://site.test:${trickle.port}/`, { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne, timeoutMs: 150 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("caps the body it keeps", async () => {
    const big = await serve((_req, res) => res.end("x".repeat(50_000)));
    const r = await guardedFetch(`http://site.test:${big.port}/`, { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne, maxBodyBytes: 1000 });
    expect(r.body).toHaveLength(1000);
    expect(r.truncated).toBe(true);
  });

  it("decodes compressed bodies, and the cap counts DECODED bytes (no compression bomb)", async () => {
    const gz = await serve((_req, res) => {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/html" });
      res.end(zlib.gzipSync(Buffer.from(`<html>${"a".repeat(400_000)}</html>`))); // ~400 KB that travels as < 1 KB
    });
    const opts = { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne };
    const capped = await guardedFetch(`http://site.test:${gz.port}/`, { ...opts, maxBodyBytes: 5000 });
    expect(capped.body).toHaveLength(5000);
    expect(capped.body.startsWith("<html>aaaa")).toBe(true);
    expect(capped.truncated).toBe(true);

    const br = await serve((_req, res) => {
      res.writeHead(200, { "content-encoding": "br" });
      res.end(zlib.brotliCompressSync(Buffer.from("<p>brotli page</p>")));
    });
    expect((await guardedFetch(`http://site.test:${br.port}/`, opts)).body).toBe("<p>brotli page</p>");
  });

  it("can follow redirects without downloading the page, and skip unwanted content types", async () => {
    const site = await serve((req, res) => {
      if (req.url === "/short") return void res.writeHead(302, { location: "/landing" }).end();
      res.writeHead(200, { "content-type": req.url === "/logo.png" ? "image/png" : "text/html" });
      res.end("BODY".repeat(1000));
    });
    const opts = { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne };
    const followed = await guardedFetch(`http://site.test:${site.port}/short`, { ...opts, discardBody: true });
    expect(followed).toMatchObject({ status: 200, body: "", url: `http://site.test:${site.port}/landing` });

    const image = await guardedFetch(`http://site.test:${site.port}/logo.png`, { ...opts, acceptContentType: (t) => !/^image\//.test(t ?? "") });
    expect(image).toMatchObject({ status: 200, body: "" });
    expect(image.headers["content-type"]).toBe("image/png");
  });

  it("POSTs a body, and rewrites the method across redirects the way clients do", async () => {
    const site = await serve((req, res) => {
      if (req.url === "/303") return void res.writeHead(303, { location: "/done" }).end();
      if (req.url === "/307") return void res.writeHead(307, { location: "/done" }).end();
      res.end("ok");
    });
    const opts = { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne, method: "POST" as const, body: '{"a":1}', headers: { "Content-Type": "application/json" } };

    await guardedFetch(`http://site.test:${site.port}/303`, opts);
    expect(site.hits.map((h) => [h.method, h.url, h.body])).toEqual([
      ["POST", "/303", '{"a":1}'],
      ["GET", "/done", ""], // 303 → GET, body dropped
    ]);
    expect(site.hits[1]!.headers["content-type"]).toBeUndefined();

    site.hits.length = 0;
    await guardedFetch(`http://site.test:${site.port}/307`, opts);
    expect(site.hits.map((h) => [h.method, h.url, h.body])).toEqual([
      ["POST", "/307", '{"a":1}'],
      ["POST", "/done", '{"a":1}'], // 307 keeps method and body
    ]);
  });

  it("does not carry an Authorization header to a different origin", async () => {
    const other = await serve((_req, res) => res.end("other"));
    const site = await serve((_req, res) => void res.writeHead(302, { location: `http://other.test:${other.port}/x` }).end());
    await guardedFetch(`http://site.test:${site.port}/`, {
      lookup: dns({ "site.test": "127.0.0.1", "other.test": "127.0.0.1" }),
      isAllowedAddress: onlyLoopbackOne,
      headers: { Authorization: "Bearer secret", "X-Trace": "1" },
    });
    expect(site.hits[0]!.headers.authorization).toBe("Bearer secret");
    expect(other.hits[0]!.headers.authorization).toBeUndefined();
    expect(other.hits[0]!.headers["x-trace"]).toBe("1");
  });

  it("returns a non-2xx status rather than throwing", async () => {
    const site = await serve((_req, res) => void res.writeHead(404).end("nope"));
    const r = await guardedFetch(`http://site.test:${site.port}/missing`, { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne });
    expect(r).toMatchObject({ status: 404, body: "nope" });
  });

  it("reports a refused connection as a network failure", async () => {
    await expect(guardedFetch("http://site.test:9/", { lookup: dns({ "site.test": "127.0.0.1" }), isAllowedAddress: onlyLoopbackOne, timeoutMs: 2000 })).rejects.toMatchObject({
      name: "GuardedFetchError",
      code: "network",
    });
  });
});

describe("guardedFetch — custom transport (how the proxy path plugs in)", () => {
  it("vets every hop before the transport sees it, and never lets the transport follow a redirect", async () => {
    const seen: string[] = [];
    const transport: GuardedTransport = async (hop) => {
      seen.push(hop.url.toString());
      if (hop.url.pathname === "/start") return { status: 302, headers: { location: "http://10.0.0.8/admin" }, body: "", truncated: false };
      return { status: 200, headers: {}, body: "should never be reached", truncated: false };
    };
    const lookup = async (): Promise<AddressInfo[]> => [{ address: "93.184.216.34", family: 4 }];
    await expect(guardedFetch("https://public.example.com/start", { transport, lookup })).rejects.toThrow(UnsafeUrlError);
    expect(seen).toEqual(["https://public.example.com/start"]);
  });

  it("wraps a transport failure as a GuardedFetchError", async () => {
    const lookup = async (): Promise<AddressInfo[]> => [{ address: "93.184.216.34", family: 4 }];
    const failing: GuardedTransport = async () => {
      throw new Error("proxy said no");
    };
    const err = await guardedFetch("https://public.example.com/", { transport: failing, lookup }).catch((e) => e);
    expect(err).toBeInstanceOf(GuardedFetchError);
    expect(err).toMatchObject({ code: "network" });
    expect(String(err.message)).toContain("proxy said no");
  });
});
