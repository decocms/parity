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
  discoverSelectors,
  discoverSelectorsFromUrl,
  mergeDiscoveredSelectors,
} from "../../src/llm/discover-selectors.ts";
import { computeHtmlFingerprint } from "../../src/llm/html-compact.ts";
import { ParityRc } from "../../src/types/schema.ts";

const HOME_HTML = `<html><body>
  <header class="site-header"><a aria-label="Sacola" href="/cart">🛒</a></header>
  <div data-product-list><a class="product-card" href="/tenis/p">tênis</a></div>
</body></html>`;

function llmReturns(selectors: Record<string, string | string[]>) {
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

describe("discoverSelectors multi-page", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parity-selcache-mp-"));
    mkdirSync(dir, { recursive: true });
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockReset();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("home-only wrapper produces a prompt with only the ### HOME section", async () => {
    llmReturns({
      category_link: "nav a",
      product_card: ".card a",
      buy_button: "#buy",
      minicart_trigger: "#cart",
    });
    await discoverSelectorsFromUrl("https://z.com/", HOME_HTML, { cacheDir: dir });
    const call = mockCreate.mock.calls[0]![0] as {
      messages: Array<{ content: Array<{ type: string; text?: string }> | string }>;
    };
    const rawContent = call.messages[0]!.content;
    const userText = typeof rawContent === "string" ? rawContent : (rawContent[0]?.text ?? "");
    expect(userText).toContain("### HOME");
    expect(userText).not.toContain("### PLP");
    expect(userText).not.toContain("### PDP");
  });

  it("includes ### PLP and ### PDP sections only when their HTML is provided", async () => {
    llmReturns({
      category_link: "nav a",
      product_card: ".card a",
      buy_button: "#buy",
      minicart_trigger: "#cart",
    });
    const plpHtml = "<html><body><div data-product-list>plp content</div></body></html>";
    const pdpHtml = "<html><body><button>Comprar</button></body></html>";
    await discoverSelectors(
      { home: "https://z2.com/", plp: "https://z2.com/categoria", pdp: "https://z2.com/produto/p" },
      { home: HOME_HTML, plp: plpHtml, pdp: pdpHtml },
      { cacheDir: dir },
    );
    const call = mockCreate.mock.calls[0]![0] as {
      messages: Array<{ content: Array<{ type: string; text?: string }> | string }>;
    };
    const rawContent = call.messages[0]!.content;
    const userText = typeof rawContent === "string" ? rawContent : (rawContent[0]?.text ?? "");
    expect(userText).toContain("### HOME");
    expect(userText).toContain("### PLP");
    expect(userText).toContain("https://z2.com/categoria");
    expect(userText).toContain("### PDP");
    expect(userText).toContain("https://z2.com/produto/p");
  });

  it("parses low_confidence_keys from the tool call into lowConfidenceKeys (camelCase)", async () => {
    llmReturns({
      category_link: "nav a",
      product_card: ".card a",
      buy_button: "#buy",
      minicart_trigger: "#cart",
      pdp_gallery_main: ".guess-main-image",
      low_confidence_keys: ["pdp_gallery_main", "unknown_key_ignored"],
    });
    const out = await discoverSelectors(
      { home: "https://z3.com/" },
      { home: HOME_HTML },
      { cacheDir: dir },
    );
    expect(out?.pdpGalleryMain).toBe(".guess-main-image");
    expect(out?.lowConfidenceKeys).toEqual(["pdpGalleryMain"]);
  });

  it("omits lowConfidenceKeys entirely when the tool doesn't report any", async () => {
    llmReturns({
      category_link: "nav a",
      product_card: ".card a",
      buy_button: "#buy",
      minicart_trigger: "#cart",
    });
    const out = await discoverSelectors(
      { home: "https://z4.com/" },
      { home: HOME_HTML },
      { cacheDir: dir },
    );
    expect(out?.lowConfidenceKeys).toBeUndefined();
  });

  it("caches on the HOME host/fingerprint only — a fresh HOME cache hit skips the LLM even with new PLP/PDP html", async () => {
    writeCacheEntry(dir, "z5.com");
    const out = await discoverSelectors(
      { home: "https://z5.com/", plp: "https://z5.com/categoria" },
      { home: HOME_HTML, plp: "<html><body>new plp</body></html>" },
      { cacheDir: dir },
    );
    expect(mockCreate).not.toHaveBeenCalled();
    expect(out?.productCard).toBe("[data-product-card] a");
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

  it("never merges lowConfidenceKeys into the rc.selectors map", () => {
    const rc = {} as Record<string, string | string[] | undefined>;
    mergeDiscoveredSelectors(rc, {
      productCard: ".card a",
      lowConfidenceKeys: ["productCard"],
    });
    expect(rc.productCard).toBe(".card a");
    expect(rc.lowConfidenceKeys).toBeUndefined();
  });
});

describe("schema contract", () => {
  it("every DiscoveredSelectors key exists in ParityRc.selectors (nothing can be silently dropped)", () => {
    // `lowConfidenceKeys` is metadata (a string[] of field names), not a CSS
    // selector string — it's intentionally excluded from rc.selectors and
    // from mergeDiscoveredSelectors' merge loop.
    const discoveredKeys = Object.keys(DiscoveredSelectorsSchema.shape).filter(
      (k) => k !== "lowConfidenceKeys",
    );
    const rcSelectorKeys = new Set(Object.keys(ParityRc.shape.selectors.def.innerType.shape));
    for (const key of discoveredKeys) {
      expect(
        rcSelectorKeys.has(key),
        `DiscoveredSelectors.${key} missing from ParityRc.selectors`,
      ).toBe(true);
    }
  });
});
