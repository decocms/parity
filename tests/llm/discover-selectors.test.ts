import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import {
  type DiscoveredSelectors,
  DiscoveredSelectorsSchema,
  discoverSelectorsFromUrl,
  mergeDiscoveredSelectors,
} from "../../src/llm/discover-selectors.ts";
import { computeHtmlFingerprint } from "../../src/llm/html-compact.ts";
import { ParityRc } from "../../src/types/schema.ts";

const HOME_HTML = `<html><body>
  <header class="site-header"><a aria-label="Sacola" href="/cart">🛒</a></header>
  <div data-product-list><a class="product-card" href="/tenis/p">tênis</a></div>
</body></html>`;

function llmReturns(selectors: Record<string, string>) {
  mockCreate.mockResolvedValue({
    content: [{ type: "tool_use", name: "report_selectors", input: selectors }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function writeCacheEntry(
  dir: string,
  host: string,
  over: Partial<{
    schemaVersion: number;
    createdAt: string;
    htmlFingerprint: string;
    selectors: DiscoveredSelectors;
  }> = {},
) {
  const entry = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    htmlFingerprint: computeHtmlFingerprint(HOME_HTML),
    selectors: { productCard: "[data-product-card] a" },
    ...over,
  };
  writeFileSync(join(dir, `selectors-${host}.json`), JSON.stringify(entry), "utf8");
  return entry;
}

describe("discoverSelectorsFromUrl cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parity-selcache-"));
    mkdirSync(dir, { recursive: true });
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockReset();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.PARITY_SELECTOR_CACHE_TTL_DAYS;
  });

  it("hits a fresh cache entry without calling the LLM", async () => {
    writeCacheEntry(dir, "x.com");
    const out = await discoverSelectorsFromUrl("https://x.com/", HOME_HTML, { cacheDir: dir });
    expect(out?.productCard).toBe("[data-product-card] a");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("misses when the TTL expired", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeCacheEntry(dir, "x.com", { createdAt: old });
    llmReturns({
      category_link: "nav a",
      product_card: ".card a",
      buy_button: "#buy",
      minicart_trigger: "#cart",
    });
    const out = await discoverSelectorsFromUrl("https://x.com/", HOME_HTML, { cacheDir: dir });
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(out?.productCard).toBe(".card a");
  });

  it("respects PARITY_SELECTOR_CACHE_TTL_DAYS override", async () => {
    process.env.PARITY_SELECTOR_CACHE_TTL_DAYS = "30";
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    writeCacheEntry(dir, "x.com", { createdAt: old });
    const out = await discoverSelectorsFromUrl("https://x.com/", HOME_HTML, { cacheDir: dir });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(out?.productCard).toBe("[data-product-card] a");
  });

  it("misses when the page structure (fingerprint) changed", async () => {
    writeCacheEntry(dir, "x.com", { htmlFingerprint: "sha-of-old-theme" });
    llmReturns({
      category_link: "nav a",
      product_card: ".v2-card a",
      buy_button: "#buy",
      minicart_trigger: "#cart",
    });
    const out = await discoverSelectorsFromUrl("https://x.com/", HOME_HTML, { cacheDir: dir });
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(out?.productCard).toBe(".v2-card a");
  });

  it("deletes a corrupt cache file and re-discovers (no silent skip)", async () => {
    const path = join(dir, "selectors-x.com.json");
    writeFileSync(path, "{not json", "utf8");
    llmReturns({
      category_link: "nav a",
      product_card: ".card a",
      buy_button: "#buy",
      minicart_trigger: "#cart",
    });
    const out = await discoverSelectorsFromUrl("https://x.com/", HOME_HTML, { cacheDir: dir });
    expect(out?.productCard).toBe(".card a");
    // file was rewritten in the new envelope format
    const rewritten = JSON.parse(readFileSync(path, "utf8"));
    expect(rewritten.schemaVersion).toBe(1);
    expect(rewritten.htmlFingerprint).toBe(computeHtmlFingerprint(HOME_HTML));
  });

  it("treats the legacy raw-selectors format as a miss and upgrades the file", async () => {
    const path = join(dir, "selectors-x.com.json");
    writeFileSync(path, JSON.stringify({ productCard: ".legacy a" }), "utf8");
    llmReturns({
      category_link: "nav a",
      product_card: ".card a",
      buy_button: "#buy",
      minicart_trigger: "#cart",
    });
    const out = await discoverSelectorsFromUrl("https://x.com/", HOME_HTML, { cacheDir: dir });
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(out?.productCard).toBe(".card a");
    expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe(1);
  });

  it("writes the envelope format on discovery", async () => {
    llmReturns({
      category_link: "nav a",
      product_card: ".card a",
      buy_button: "#buy",
      minicart_trigger: "#cart",
      search_input: "input[name='q']",
    });
    await discoverSelectorsFromUrl("https://y.com/", HOME_HTML, { cacheDir: dir });
    const entry = JSON.parse(readFileSync(join(dir, "selectors-y.com.json"), "utf8"));
    expect(entry.schemaVersion).toBe(1);
    expect(Date.parse(entry.createdAt)).toBeGreaterThan(0);
    expect(entry.selectors.searchInput).toBe("input[name='q']");
  });

  it("noCache bypasses a fresh entry", async () => {
    writeCacheEntry(dir, "x.com");
    llmReturns({
      category_link: "nav a",
      product_card: ".fresh a",
      buy_button: "#buy",
      minicart_trigger: "#cart",
    });
    const out = await discoverSelectorsFromUrl("https://x.com/", HOME_HTML, {
      cacheDir: dir,
      noCache: true,
    });
    expect(out?.productCard).toBe(".fresh a");
  });
});

describe("mergeDiscoveredSelectors", () => {
  it("merges ALL discovered keys, never overriding user values", () => {
    const rc = { productCard: ".user-card a" } as Record<string, string | undefined>;
    const discovered: DiscoveredSelectors = {
      productCard: ".llm-card a",
      searchInput: "input[name='q']",
      pdpGalleryThumbnail: ".thumb",
      loginTrigger: "a.login",
      accountMenuTrigger: ".account",
    };
    mergeDiscoveredSelectors(rc, discovered);
    expect(rc.productCard).toBe(".user-card a"); // user wins
    // Previously discarded keys now land:
    expect(rc.searchInput).toBe("input[name='q']");
    expect(rc.pdpGalleryThumbnail).toBe(".thumb");
    expect(rc.loginTrigger).toBe("a.login");
    expect(rc.accountMenuTrigger).toBe(".account");
  });

  it("does not clobber unrelated pre-existing keys (journey.ts regression)", () => {
    const rc = { sizeSwatch: "[data-size]", cartItemRow: ".row" } as Record<
      string,
      string | undefined
    >;
    mergeDiscoveredSelectors(rc, { productCard: ".card a" });
    expect(rc.sizeSwatch).toBe("[data-size]");
    expect(rc.cartItemRow).toBe(".row");
    expect(rc.productCard).toBe(".card a");
  });
});

describe("schema contract", () => {
  it("every DiscoveredSelectors key exists in ParityRc.selectors (nothing can be silently dropped)", () => {
    const discoveredKeys = Object.keys(DiscoveredSelectorsSchema.shape);
    const rcSelectorKeys = new Set(Object.keys(ParityRc.shape.selectors.def.innerType.shape));
    for (const key of discoveredKeys) {
      expect(
        rcSelectorKeys.has(key),
        `DiscoveredSelectors.${key} missing from ParityRc.selectors`,
      ).toBe(true);
    }
  });
});
