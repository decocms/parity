import { describe, expect, it } from "vitest";
import { type RunOptions, applySmartDefaults } from "../../src/commands/run.ts";

/**
 * Issue #178 (problem 2, compounding gap): without an LLM provider,
 * `applySmartDefaults` (issue #71) used to force `noVisualDiff = true`
 * whenever `visualPages` still equaled commander's default (5) — even when
 * the user explicitly passed `--pages`/`--pages-file`. That silently
 * disabled the whole visual-diff capture branch in `runCommand`
 * (`if (browser && visualPagesLimit > 0)`), regardless of how many explicit
 * paths were given, making `--pages` inert in no-LLM environments. Explicit
 * `--pages` is deliberate intent and should still get the prod/cand
 * screenshot + pixelmatch heatmap capture even without an LLM verdict.
 */
describe("applySmartDefaults + explicit --pages (#178)", () => {
  const base: RunOptions = {
    prod: "https://prod.example.com",
    cand: "https://cand.example.com",
    flows: "purchase-journey",
    viewports: "mobile",
    cep: "01310-100",
    runs: "1",
    output: "./parity-output",
    ci: false,
    failOn: "critical",
    visualPages: 5, // untouched — still commander's default
  };

  it("auto-zeroes visualPages/noVisualDiff when no LLM and --pages absent", () => {
    const out = applySmartDefaults(base, false);
    expect(out.visualPages).toBe(0);
    expect(out.noVisualDiff).toBe(true);
  });

  it("does NOT force noVisualDiff when --pages is explicitly set, even with no LLM", () => {
    const out = applySmartDefaults({ ...base, pages: "/produto/x,/produto/y" }, false);
    expect(out.noVisualDiff).toBeUndefined();
    expect(out.visualPages).toBe(5);
  });

  it("does NOT force noVisualDiff when --pages-file is explicitly set, even with no LLM", () => {
    const out = applySmartDefaults({ ...base, pagesFile: "./pages.txt" }, false);
    expect(out.noVisualDiff).toBeUndefined();
    expect(out.visualPages).toBe(5);
  });

  it("is a no-op when an LLM provider is available, --pages or not", () => {
    const out = applySmartDefaults(base, true);
    expect(out).toBe(base);
  });
});
