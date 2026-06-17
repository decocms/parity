import { describe, expect, it } from "vitest";
import {
  buildCacheReport,
  cacheDecision,
  classifyResource,
  isStaticAssetWithHash,
  isThirdParty,
} from "../../src/diff/cache.ts";
import type { NetworkEntry } from "../../src/types/schema.ts";

function entry(over: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    url: "https://example.com/a.js",
    method: "GET",
    status: 200,
    resourceType: "script",
    fromCache: false,
    bytes: 1000,
    durationMs: 100,
    cacheControl: null,
    serverTiming: null,
    decoSection: null,
    ...over,
  };
}

describe("cacheDecision", () => {
  it("returns hit when fromCache is true", () => {
    expect(cacheDecision(entry({ fromCache: true }))).toBe("hit");
  });

  it("returns bypass for no-store / no-cache / private", () => {
    expect(cacheDecision(entry({ cacheControl: "no-store" }))).toBe("bypass");
    expect(cacheDecision(entry({ cacheControl: "private, max-age=60" }))).toBe("bypass");
    expect(cacheDecision(entry({ cacheControl: "no-cache" }))).toBe("bypass");
  });

  it("is case-insensitive on cache-control", () => {
    expect(cacheDecision(entry({ cacheControl: "No-Store" }))).toBe("bypass");
  });

  it("returns 'cacheable' when there's a deliberate max-age ≥60s (asset is properly configured)", () => {
    expect(cacheDecision(entry({ cacheControl: "max-age=60" }))).toBe("cacheable");
    expect(cacheDecision(entry({ cacheControl: "public, max-age=3600" }))).toBe("cacheable");
    expect(cacheDecision(entry({ cacheControl: "public, max-age=31536000, immutable" }))).toBe(
      "cacheable",
    );
  });

  it("falls back to unknown when cache-control is missing or zero", () => {
    expect(cacheDecision(entry({ cacheControl: null }))).toBe("unknown");
    expect(cacheDecision(entry({ cacheControl: "max-age=0" }))).toBe("unknown");
    expect(cacheDecision(entry({ cacheControl: "max-age=30" }))).toBe("unknown");
  });
});

describe("isStaticAssetWithHash", () => {
  it("detects 8-32 char hex hashes in filename", () => {
    expect(isStaticAssetWithHash("/assets/app.deadbeef.js")).toBe(true);
    expect(isStaticAssetWithHash("/assets/app.a1b2c3d4e5f6.css")).toBe(true);
    expect(isStaticAssetWithHash("/img/photo-a1b2c3d4e5f6.webp")).toBe(true);
  });

  it("ignores assets without a hash", () => {
    expect(isStaticAssetWithHash("/assets/app.js")).toBe(false);
    expect(isStaticAssetWithHash("/styles.css")).toBe(false);
  });

  it("ignores too-short hashes", () => {
    expect(isStaticAssetWithHash("/app.abc.js")).toBe(false);
  });
});

describe("isThirdParty", () => {
  it("flags known trackers", () => {
    expect(isThirdParty("https://www.googletagmanager.com/gtm.js", "example.com")).toBe(true);
    expect(isThirdParty("https://connect.facebook.net/pixel.js", "example.com")).toBe(true);
    expect(isThirdParty("https://script.hotjar.com/x.js", "example.com")).toBe(true);
  });

  it("treats subdomains of base host as first-party", () => {
    expect(isThirdParty("https://www.example.com/a.js", "example.com")).toBe(false);
    expect(isThirdParty("https://cdn.example.com/a.js", "example.com")).toBe(false);
  });

  it("treats www-stripped base host as first-party", () => {
    expect(isThirdParty("https://example.com/a.js", "www.example.com")).toBe(false);
  });

  it("treats known commerce CDNs (vtexassets, decoassets, vteximg) as first-party", () => {
    expect(isThirdParty("https://something.vtexassets.com/x.js", "example.com")).toBe(false);
    expect(isThirdParty("https://decoassets.com/x.js", "example.com")).toBe(false);
  });

  it("treats deco image proxy / edge cache as first-party", () => {
    // decoims.com is the deco image optimizer (`/image?fit=cover&src=...`)
    // decocache.com is the deco edge cache (assets.decocache.com/<site>/...)
    // Both are storefront-owned infra; they need to be eligible for
    // cache-coverage opportunities, not filtered out as third-party.
    expect(isThirdParty("https://decoims.com/image?src=miess-01/foo.png", "miess.com.br")).toBe(
      false,
    );
    expect(
      isThirdParty("https://assets.decocache.com/miess-01/abc/banner.jpg", "miess.com.br"),
    ).toBe(false);
  });

  it("returns false for malformed URLs (bug #21: conservative classification)", () => {
    // Conservative: malformed URL should not crash and should not be flagged 3rd party.
    expect(isThirdParty("http://[invalid", "example.com")).toBe(false);
  });

  it("flags unrelated hosts as third-party", () => {
    expect(isThirdParty("https://random.com/x.js", "example.com")).toBe(true);
  });
});

describe("classifyResource", () => {
  it("classifies document/image/font/static-asset/api correctly", () => {
    expect(classifyResource(entry({ resourceType: "document" }), "example.com")).toBe("document");
    expect(classifyResource(entry({ resourceType: "image" }), "example.com")).toBe("image");
    expect(classifyResource(entry({ resourceType: "font" }), "example.com")).toBe("font");
    expect(classifyResource(entry({ resourceType: "stylesheet" }), "example.com")).toBe(
      "static-asset",
    );
    expect(classifyResource(entry({ resourceType: "script" }), "example.com")).toBe("static-asset");
    expect(
      classifyResource(
        entry({ resourceType: "xhr", url: "https://example.com/api/x" }),
        "example.com",
      ),
    ).toBe("api");
  });

  it("classifies deco/_loader and /deco/render as api", () => {
    expect(
      classifyResource(
        entry({ resourceType: "fetch", url: "https://example.com/_loader/abc" }),
        "example.com",
      ),
    ).toBe("api");
    expect(
      classifyResource(
        entry({ resourceType: "fetch", url: "https://example.com/deco/render?s=hero" }),
        "example.com",
      ),
    ).toBe("api");
  });

  it("classifies third-party hosts as third-party regardless of resourceType", () => {
    expect(
      classifyResource(
        entry({ resourceType: "script", url: "https://googletagmanager.com/gtm.js" }),
        "example.com",
      ),
    ).toBe("third-party");
  });

  it("falls back to .woff2 as font even when resourceType is not 'font'", () => {
    expect(
      classifyResource(
        entry({ resourceType: "other", url: "https://example.com/x.woff2" }),
        "example.com",
      ),
    ).toBe("font");
  });
});

describe("buildCacheReport", () => {
  it("computes hit rate excluding third-party requests", () => {
    const r = buildCacheReport(
      [
        entry({ url: "https://example.com/a.js", fromCache: true, resourceType: "script" }),
        entry({ url: "https://example.com/b.js", fromCache: false, resourceType: "script" }),
        // 3rd-party should NOT enter the hit rate denominator
        entry({
          url: "https://googletagmanager.com/gtm.js",
          fromCache: false,
          resourceType: "script",
        }),
      ],
      "https://example.com",
    );
    // 1 hit / 2 first-party = 0.5
    expect(r.hitRate).toBe(0.5);
    expect(r.total).toBe(3);
  });

  it("flags hashed static assets that MISS as opportunities", () => {
    const r = buildCacheReport(
      [
        entry({
          url: "https://example.com/app.a1b2c3d4e5f6.js",
          fromCache: false,
          resourceType: "script",
          bytes: 50_000,
        }),
        entry({
          url: "https://example.com/app.deadbeef.css",
          fromCache: false,
          resourceType: "stylesheet",
          bytes: 20_000,
        }),
      ],
      "https://example.com",
    );
    expect(r.opportunities.length).toBeGreaterThanOrEqual(1);
    // Sorted by bytes desc — JS first
    expect(r.opportunities[0]?.entry.url).toContain("app.a1b2c3d4");
  });

  it("does not flag api requests as opportunities", () => {
    const r = buildCacheReport(
      [entry({ url: "https://example.com/api/cart", fromCache: false, resourceType: "fetch" })],
      "https://example.com",
    );
    expect(r.opportunities).toHaveLength(0);
  });

  it("handles entries with null bytes without crashing", () => {
    const r = buildCacheReport([entry({ bytes: null })], "https://example.com");
    expect(r.totalBytes).toBe(0);
    expect(r.total).toBe(1);
  });

  it("returns zero hit rate when no first-party requests exist", () => {
    const r = buildCacheReport(
      [entry({ url: "https://googletagmanager.com/gtm.js" })],
      "https://example.com",
    );
    expect(r.hitRate).toBe(0);
  });

  it("handles malformed baseUrl gracefully", () => {
    expect(() => buildCacheReport([entry()], "http://[invalid")).not.toThrow();
  });
});
