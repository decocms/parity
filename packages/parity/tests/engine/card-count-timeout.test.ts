import { describe, expect, it, vi } from "vitest";
import { waitForCardGrowth } from "../../src/engine/benchmark.ts";
import { countProductCards, measureProductCards } from "../../src/engine/flows/simple.ts";

/**
 * A page whose `evaluate` returns the queued values in order. `null` stands for a read that never
 * resolves within the cap (a saturated main thread), simulated as a rejection — `measureProductCards`
 * maps both to `null`.
 */
function fakePage(reads: (number | "fail")[]) {
  let i = 0;
  return {
    evaluate: vi.fn(async () => {
      const v = reads[Math.min(i++, reads.length - 1)];
      if (v === "fail") throw new Error("execution context destroyed");
      return v;
    }),
    waitForTimeout: vi.fn(async () => undefined),
  } as unknown as import("playwright").Page;
}

describe("measureProductCards (#273)", () => {
  it("returns the count in a single evaluate, not one locator call per selector", async () => {
    const page = fakePage([48]);
    expect(await measureProductCards(page)).toBe(48);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it("returns null when the page could not be measured", async () => {
    expect(await measureProductCards(fakePage(["fail"]))).toBeNull();
  });

  it("still returns 0 for a genuinely empty grid", async () => {
    expect(await measureProductCards(fakePage([0]))).toBe(0);
  });
});

describe("countProductCards (#273)", () => {
  it("keeps its number contract for existing callers, collapsing an unmeasurable page to 0", async () => {
    expect(await countProductCards(fakePage([12]))).toBe(12);
    expect(await countProductCards(fakePage(["fail"]))).toBe(0);
  });
});

describe("waitForCardGrowth (#273)", () => {
  it("returns the new count as soon as the grid grows", async () => {
    expect(await waitForCardGrowth(fakePage([72]), 48, 5_000)).toBe(72);
  });

  it("ignores a failed read instead of reporting it as an empty grid", async () => {
    // This is the regression: a timeout used to yield 0, and `0 <= before` was read as
    // "no more products", aborting the rest of the pagination run.
    const page = fakePage(["fail", "fail", 72]);
    expect(await waitForCardGrowth(page, 48, 5_000)).toBe(72);
  });

  it("never moves the count backwards because of a failed read", async () => {
    const page = fakePage([48, "fail", "fail"]);
    const out = await waitForCardGrowth(page, 48, 150);
    expect(out).toBe(48);
    expect(out).not.toBe(0);
  });

  it("still reports no growth for a grid that is genuinely exhausted", async () => {
    expect(await waitForCardGrowth(fakePage([48]), 48, 150)).toBe(48);
  });

  it("reports a real emptying of the grid, which is not the same as a failed read", async () => {
    expect(await waitForCardGrowth(fakePage([0]), 48, 150)).toBe(0);
  });
});
