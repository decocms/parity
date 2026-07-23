import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { validateSelectors } from "../../src/engine/validate-selectors.ts";
import type { DiscoveredSelectors } from "../../src/llm/discover-selectors.ts";

/**
 * Minimal fake `Page` — only `locator(sel).count()` is exercised by
 * `validateSelectors`, so that's all we implement. Selector→count is a
 * lookup table set per test; unlisted selectors reject (simulating a
 * Playwright timeout/error) so the "treated as failed" path is covered too.
 */
function fakePage(counts: Record<string, number | "hang">): Page {
  return {
    locator: (sel: string) => ({
      count: () => {
        const v = counts[sel];
        if (v === undefined) return Promise.reject(new Error(`no locator stub for ${sel}`));
        if (v === "hang") return new Promise(() => {}); // never resolves — exercises the timeout cap
        return Promise.resolve(v);
      },
    }),
  } as unknown as Page;
}

describe("validateSelectors", () => {
  it("marks a selector validated when count() > 0", async () => {
    const page = fakePage({ ".card": 3 });
    const selectors: DiscoveredSelectors = { productCard: ".card" };
    const result = await validateSelectors(page, selectors);
    expect(result.validated.productCard).toBe(true);
    expect(result.failed).not.toContain("productCard");
  });

  it("marks a selector failed when count() === 0", async () => {
    const page = fakePage({ ".missing": 0 });
    const selectors: DiscoveredSelectors = { productCard: ".missing" };
    const result = await validateSelectors(page, selectors);
    expect(result.validated.productCard).toBe(false);
    expect(result.failed).toContain("productCard");
  });

  it("skips empty/absent selectors entirely (neither validated nor failed)", async () => {
    const page = fakePage({});
    const selectors: DiscoveredSelectors = { productCard: undefined, buyButton: "" };
    const result = await validateSelectors(page, selectors);
    expect(result.validated.productCard).toBeUndefined();
    expect(result.validated.buyButton).toBeUndefined();
    expect(result.failed).toHaveLength(0);
  });

  it("treats a hung/timed-out probe as failed, not as a hang", async () => {
    const page = fakePage({ ".slow": "hang" });
    const selectors: DiscoveredSelectors = { minicartTrigger: ".slow" };
    const start = Date.now();
    const result = await validateSelectors(page, selectors);
    expect(Date.now() - start).toBeLessThan(4_000);
    expect(result.validated.minicartTrigger).toBe(false);
    expect(result.failed).toContain("minicartTrigger");
  }, 8_000);

  it("treats a rejected locator.count() as failed", async () => {
    const page = fakePage({});
    const selectors: DiscoveredSelectors = { checkoutButton: ".no-stub" };
    const result = await validateSelectors(page, selectors);
    expect(result.validated.checkoutButton).toBe(false);
    expect(result.failed).toContain("checkoutButton");
  });

  it("never probes lowConfidenceKeys (it's metadata, not a selector)", async () => {
    const page = fakePage({ ".card": 1 });
    const selectors: DiscoveredSelectors = {
      productCard: ".card",
      lowConfidenceKeys: ["productCard"],
    };
    const result = await validateSelectors(page, selectors);
    expect(Object.keys(result.validated)).toEqual(["productCard"]);
  });

  it("validates multiple selectors independently", async () => {
    const page = fakePage({ ".a": 1, ".b": 0 });
    const selectors: DiscoveredSelectors = { categoryLink: ".a", minicartTrigger: ".b" };
    const result = await validateSelectors(page, selectors);
    expect(result.validated.categoryLink).toBe(true);
    expect(result.validated.minicartTrigger).toBe(false);
    expect(result.failed).toEqual(["minicartTrigger"]);
  });
});
