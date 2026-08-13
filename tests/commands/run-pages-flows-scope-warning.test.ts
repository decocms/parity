import { describe, expect, it } from "vitest";
import { pagesFlowsScopeWarning } from "../../src/commands/run.ts";

/**
 * Issue #178 (problem 2): `--pages`/`--pages-file` only scope the
 * visual-diff/vitals-extra-pages passes — the `flows` crawl discovers its
 * own target pages independently and silently ignores them. `runCommand`
 * prints a one-line heads-up when both are in play for the same run.
 */
describe("pagesFlowsScopeWarning (#178)", () => {
  it("returns null when neither --pages nor --pages-file is set", () => {
    expect(pagesFlowsScopeWarning({}, ["purchase-journey"])).toBeNull();
  });

  it("returns null when no flows are running, even with --pages set", () => {
    expect(pagesFlowsScopeWarning({ pages: "/produto/x" }, [])).toBeNull();
  });

  it("warns once, naming the active flows, when --pages is set and flows run", () => {
    const msg = pagesFlowsScopeWarning({ pages: "/produto/x,/produto/y" }, [
      "purchase-journey",
      "search",
    ]);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/--pages\/--pages-file only scope/);
    expect(msg).toMatch(/purchase-journey,search/);
  });

  it("warns when only --pages-file is set", () => {
    const msg = pagesFlowsScopeWarning({ pagesFile: "./pages.txt" }, ["purchase-journey"]);
    expect(msg).not.toBeNull();
  });
});
