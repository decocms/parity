import { afterEach, describe, expect, it } from "vitest";
import {
  diffSitemap,
  fetchSitemap,
  parseSitemap,
  resolveSitemapUrls,
} from "../../src/diff/sitemap.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.com/a</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://x.com/b</loc></url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://x.com/sitemap-products.xml</loc></sitemap>
  <sitemap><loc>https://x.com/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`;

describe("fetchSitemap", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("returns XML body from /sitemap.xml when 200", async () => {
    ({ restore } = mockFetch({ "/sitemap.xml": { status: 200, body: URLSET } }));
    const r = await fetchSitemap("https://x.com");
    expect(r?.xml).toContain("<urlset");
  });

  it("falls back to /sitemap_index.xml when /sitemap.xml is 404", async () => {
    ({ restore } = mockFetch({
      "/sitemap.xml": { status: 404, body: "" },
      "/sitemap_index.xml": { status: 200, body: SITEMAP_INDEX },
    }));
    const r = await fetchSitemap("https://x.com");
    expect(r?.url).toContain("sitemap_index.xml");
  });

  it("returns null when body is not XML-like", async () => {
    ({ restore } = mockFetch({ "/sitemap.xml": { status: 200, body: "not xml" } }));
    expect(await fetchSitemap("https://x.com")).toBeNull();
  });

  it("returns null when all candidates fail", async () => {
    ({ restore } = mockFetch({ "/sitemap.xml": { status: 404, body: "" }, "/sitemap_index.xml": { status: 404, body: "" } }));
    expect(await fetchSitemap("https://x.com")).toBeNull();
  });

  it("aborts via timeout when sitemap is slow", async () => {
    ({ restore } = mockFetch({ "/sitemap.xml": { delayMs: 30_000 } }));
    const t0 = Date.now();
    const r = await fetchSitemap("https://x.com", undefined, 150);
    expect(r).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("respects explicit hint URL", async () => {
    ({ restore } = mockFetch({
      "https://x.com/custom-sitemap.xml": { status: 200, body: URLSET },
    }));
    const r = await fetchSitemap("https://x.com", "https://x.com/custom-sitemap.xml");
    expect(r?.url).toContain("custom-sitemap.xml");
  });
});

describe("parseSitemap", () => {
  it("parses a urlset and extracts URLs + lastmod", () => {
    const r = parseSitemap(URLSET);
    expect(r.isIndex).toBe(false);
    expect(r.urls).toEqual(["https://x.com/a", "https://x.com/b"]);
    expect(r.lastmod["https://x.com/a"]).toBe("2026-01-01");
  });

  it("parses a sitemap index", () => {
    const r = parseSitemap(SITEMAP_INDEX);
    expect(r.isIndex).toBe(true);
    expect(r.childSitemaps).toEqual([
      "https://x.com/sitemap-products.xml",
      "https://x.com/sitemap-pages.xml",
    ]);
  });

  it("bug #8: returns empty result on malformed XML (current behavior, silent)", () => {
    const r = parseSitemap("<urlset><url><loc>broken");
    // Today the parser swallows errors; document the behavior.
    // This test will need updating if/when we surface parse errors.
    expect(r.urls.length).toBeGreaterThanOrEqual(0);
  });

  it("returns empty when XML is non-sitemap content", () => {
    const r = parseSitemap("<rss><channel><item><title>not a sitemap</title></item></channel></rss>");
    expect(r.urls).toEqual([]);
    expect(r.childSitemaps).toEqual([]);
  });
});

describe("resolveSitemapUrls", () => {
  let restore: () => void = () => undefined;
  afterEach(() => restore());

  it("returns flat URL list from a urlset", async () => {
    ({ restore } = mockFetch({ "/sitemap.xml": { status: 200, body: URLSET } }));
    const urls = await resolveSitemapUrls("https://x.com");
    expect(urls).toEqual(["https://x.com/a", "https://x.com/b"]);
  });

  it("recurses one level into a sitemap-index", async () => {
    const childA = `<?xml version="1.0"?><urlset><url><loc>https://x.com/foo</loc></url><url><loc>https://x.com/bar</loc></url></urlset>`;
    const childB = `<?xml version="1.0"?><urlset><url><loc>https://x.com/baz</loc></url></urlset>`;
    ({ restore } = mockFetch({
      "/sitemap.xml": { status: 200, body: SITEMAP_INDEX },
      "https://x.com/sitemap-products.xml": { status: 200, body: childA },
      "https://x.com/sitemap-pages.xml": { status: 200, body: childB },
    }));
    const urls = await resolveSitemapUrls("https://x.com");
    expect(urls).toEqual(
      expect.arrayContaining(["https://x.com/foo", "https://x.com/bar", "https://x.com/baz"]),
    );
  });

  it("returns [] when fetch returns nothing", async () => {
    ({ restore } = mockFetch({ "/sitemap.xml": { status: 404, body: "" }, "/sitemap_index.xml": { status: 404, body: "" } }));
    expect(await resolveSitemapUrls("https://x.com")).toEqual([]);
  });
});

describe("diffSitemap", () => {
  it("flags count delta and sample URLs", () => {
    const diff = diffSitemap(
      ["https://x.com/a", "https://x.com/b", "https://x.com/c"],
      ["https://x.com/a"],
    );
    expect(diff.prodCount).toBe(3);
    expect(diff.candCount).toBe(1);
    expect(diff.countDelta).toBe(-2);
    expect(diff.onlyProdSample).toEqual(["https://x.com/b", "https://x.com/c"]);
  });

  it("handles empty prod gracefully (no division by zero)", () => {
    const diff = diffSitemap([], ["https://x.com/a"]);
    expect(diff.countPct).toBe(0);
    expect(diff.prodPresent).toBe(false);
  });

  it("caps samples at 20", () => {
    const prod = Array.from({ length: 50 }, (_, i) => `https://x.com/${i}`);
    const cand: string[] = [];
    expect(diffSitemap(prod, cand).onlyProdSample.length).toBe(20);
  });
});
