import { describe, expect, it } from "vitest";
import { ALL_CHECKS_BY_NAME, runAllChecks } from "../../src/checks/index.ts";
import { makeContext } from "../helpers/make-context.ts";

describe("runAllChecks", () => {
  it("runs every registered check when checkFilter is absent (unchanged full-run behavior)", async () => {
    const ctx = makeContext();
    const results = await runAllChecks(ctx);
    expect(results.length).toBe(Object.keys(ALL_CHECKS_BY_NAME).length);
    const names = new Set(results.map((r) => r.name));
    for (const name of Object.keys(ALL_CHECKS_BY_NAME)) {
      expect(names.has(name)).toBe(true);
    }
  });

  it("runs only the checks named in checkFilter, omitting the rest entirely", async () => {
    const ctx = makeContext();
    const filter = new Set(["cache-coverage", "html-structural-diff"]);
    const results = await runAllChecks(ctx, undefined, filter);
    expect(results.length).toBe(2);
    const names = new Set(results.map((r) => r.name));
    expect(names).toEqual(new Set(["cache-coverage", "html-structural-diff"]));
  });

  it("an empty checkFilter runs zero checks", async () => {
    const ctx = makeContext();
    const results = await runAllChecks(ctx, undefined, new Set());
    expect(results).toEqual([]);
  });

  it("unknown names in checkFilter are silently ignored (not run, no crash)", async () => {
    const ctx = makeContext();
    const filter = new Set(["cache-coverage", "not-a-real-check"]);
    const results = await runAllChecks(ctx, undefined, filter);
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe("cache-coverage");
  });
});
