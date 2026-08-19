import { describe, expect, it, vi } from "vitest";
import { mergeInpSnapshot, readVitalsSnapshot } from "../../src/engine/collect.ts";
import type { WebVitals } from "../../src/types/schema.ts";

/**
 * Regression test for issue #184: `window.__parity_vitals` was read in
 * exactly one place (`capturePage`, right after its own `page.goto`), so
 * `inp` — which only ever populates from real user interactions — was
 * structurally always `null`. `readVitalsSnapshot` + `mergeInpSnapshot` let
 * flow steps sample it mid-visit, after a real click, without navigating.
 */

const baseVitals: WebVitals = { lcp: 1200, cls: 0.02, fcp: 800, ttfb: 150, inp: null };

describe("mergeInpSnapshot", () => {
  it("adopts inp from the snapshot when the base capture never had one", () => {
    const merged = mergeInpSnapshot(baseVitals, { ...baseVitals, inp: 180 });
    expect(merged.inp).toBe(180);
  });

  it("keeps the base inp when the snapshot has none", () => {
    const withInp = { ...baseVitals, inp: 120 };
    const merged = mergeInpSnapshot(withInp, { ...baseVitals, inp: null });
    expect(merged.inp).toBe(120);
  });

  it("keeps the base inp when the snapshot is null (evaluate failed/timed out)", () => {
    const withInp = { ...baseVitals, inp: 120 };
    expect(mergeInpSnapshot(withInp, null).inp).toBe(120);
  });

  it("takes the larger of the two — a later interaction produced a worse INP", () => {
    const withInp = { ...baseVitals, inp: 120 };
    const merged = mergeInpSnapshot(withInp, { ...baseVitals, inp: 340 });
    expect(merged.inp).toBe(340);
  });

  it("does NOT regress inp when the snapshot happens to read lower", () => {
    // Same document, worst-case-so-far tracker — a later read should never
    // be smaller for a real page, but stay defensive: never let a merge
    // silently erase a previously observed (worse) value.
    const withInp = { ...baseVitals, inp: 340 };
    const merged = mergeInpSnapshot(withInp, { ...baseVitals, inp: 120 });
    expect(merged.inp).toBe(340);
  });

  it("leaves lcp/cls/fcp/ttfb untouched — only inp is merged", () => {
    const base = { lcp: 1200, cls: 0.02, fcp: 800, ttfb: 150, inp: null };
    const snapshot: WebVitals = { lcp: 9999, cls: 0.9, fcp: 9999, ttfb: 9999, inp: 200 };
    const merged = mergeInpSnapshot(base, snapshot);
    expect(merged).toEqual({ lcp: 1200, cls: 0.02, fcp: 800, ttfb: 150, inp: 200 });
  });
});

describe("readVitalsSnapshot", () => {
  it("reads window.__parity_vitals via page.evaluate without navigating", async () => {
    const vitals: WebVitals = { lcp: 1000, cls: 0, fcp: 500, ttfb: 100, inp: 250 };
    const evaluate = vi.fn().mockResolvedValue(vitals);
    const goto = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: minimal Page mock
    const page = { evaluate, goto } as any;

    const result = await readVitalsSnapshot(page);

    expect(result).toEqual(vitals);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(goto).not.toHaveBeenCalled();
  });

  it("returns null when evaluate rejects (e.g. page mid-navigation)", async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error("execution context destroyed"));
    // biome-ignore lint/suspicious/noExplicitAny: minimal Page mock
    const page = { evaluate } as any;

    expect(await readVitalsSnapshot(page)).toBeNull();
  });

  it("returns null when the collector was never installed on this document", async () => {
    const evaluate = vi.fn().mockResolvedValue(undefined);
    // biome-ignore lint/suspicious/noExplicitAny: minimal Page mock
    const page = { evaluate } as any;

    expect(await readVitalsSnapshot(page)).toBeNull();
  });
});
