import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffRobots, fetchRobots, parseRobots } from "../../src/diff/robots.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

describe("fetchRobots", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("returns text body on 200", async () => {
    ({ restore } = mockFetch({
      "/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /admin\n" },
    }));
    const txt = await fetchRobots("https://x.com");
    expect(txt).toContain("Disallow: /admin");
  });

  it("returns null on non-200", async () => {
    ({ restore } = mockFetch({ "/robots.txt": { status: 404, body: "Not Found" } }));
    expect(await fetchRobots("https://x.com")).toBeNull();
  });

  it("returns null when body is HTML (some sites serve their 404 as robots.txt)", async () => {
    ({ restore } = mockFetch({
      "/robots.txt": { status: 200, body: "<html><body>Not found</body></html>" },
    }));
    expect(await fetchRobots("https://x.com")).toBeNull();
  });

  it("returns null on network error", async () => {
    ({ restore } = mockFetch({ "/robots.txt": { error: "ENETUNREACH" } }));
    expect(await fetchRobots("https://x.com")).toBeNull();
  });

  it("aborts via AbortSignal when slow (timeout enforcement)", async () => {
    ({ restore } = mockFetch({ "/robots.txt": { delayMs: 30_000 } }));
    const t0 = Date.now();
    const result = await fetchRobots("https://x.com", 100);
    expect(result).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("parseRobots", () => {
  it("parses User-agent rules and sitemaps", () => {
    const r = parseRobots(`
User-agent: *
Disallow: /admin
Allow: /admin/help

User-agent: Googlebot
Disallow: /private

Sitemap: https://x.com/sitemap.xml
Sitemap: https://x.com/sitemap-2.xml
`);
    expect(r.userAgents["*"]?.disallow).toContain("/admin");
    expect(r.userAgents["*"]?.allow).toContain("/admin/help");
    expect(r.userAgents.googlebot?.disallow).toContain("/private");
    expect(r.sitemaps).toEqual([
      "https://x.com/sitemap-2.xml",
      "https://x.com/sitemap.xml",
    ]);
  });

  it("treats User-agent values case-insensitively (bug #16)", () => {
    const r = parseRobots(`
User-agent: Googlebot
Disallow: /a

User-agent: googlebot
Disallow: /b
`);
    // Both should land in the same lowercased key
    expect(r.userAgents.googlebot?.disallow).toEqual(["/a", "/b"]);
  });

  it("parses crawl-delay as a number", () => {
    const r = parseRobots("User-agent: *\nCrawl-delay: 10\n");
    expect(r.userAgents["*"]?.crawlDelay).toBe(10);
  });

  it("ignores comments and blank lines", () => {
    const r = parseRobots("# top comment\n\nUser-agent: *\n# nested\nDisallow: /x\n");
    expect(r.userAgents["*"]?.disallow).toEqual(["/x"]);
  });

  it("bug #10: silently ignores typo directives (User-Agentt) but does not crash", () => {
    const r = parseRobots("User-Agentt: typo\nDisallow: /x\n");
    expect(Object.keys(r.userAgents)).toEqual([]); // typo'd UA never registers
  });

  it("normalizes lists (sorted) so set comparisons are stable", () => {
    const r = parseRobots("User-agent: *\nDisallow: /z\nDisallow: /a\n");
    expect(r.userAgents["*"]?.disallow).toEqual(["/a", "/z"]);
  });
});

describe("diffRobots", () => {
  it("flags cand-only Disallow as divergence", () => {
    const prod = parseRobots("User-agent: *\nAllow: /\n");
    const cand = parseRobots("User-agent: *\nDisallow: /\n");
    const d = diffRobots(prod, cand);
    expect(d.anyDivergence).toBe(true);
    expect(d.uaDiffs[0]?.disallowOnlyCand).toContain("/");
  });

  it("returns prodOnly/candOnly flags correctly when one side missing", () => {
    const prod = parseRobots("User-agent: *\nDisallow: /a\n");
    const d1 = diffRobots(prod, null);
    expect(d1.prodOnly).toBe(true);
    expect(d1.anyDivergence).toBe(true);

    const d2 = diffRobots(null, prod);
    expect(d2.candOnly).toBe(true);
  });

  it("flags sitemap-only-in-prod regressions", () => {
    const prod = parseRobots("User-agent: *\nSitemap: https://x.com/s.xml\n");
    const cand = parseRobots("User-agent: *\n");
    const d = diffRobots(prod, cand);
    expect(d.sitemapDiff.onlyProd).toContain("https://x.com/s.xml");
    expect(d.anyDivergence).toBe(true);
  });

  it("no divergence when both sides identical", () => {
    const txt = "User-agent: *\nDisallow: /admin\nSitemap: https://x.com/s.xml\n";
    expect(diffRobots(parseRobots(txt), parseRobots(txt)).anyDivergence).toBe(false);
  });

  it("flags crawl-delay change for a UA", () => {
    const prod = parseRobots("User-agent: *\nCrawl-delay: 1\n");
    const cand = parseRobots("User-agent: *\nCrawl-delay: 10\n");
    const d = diffRobots(prod, cand);
    expect(d.uaDiffs[0]?.crawlDelayProd).toBe(1);
    expect(d.uaDiffs[0]?.crawlDelayCand).toBe(10);
  });
});
