import { describe, expect, it } from "vitest";
import { ALL_CHECKS_BY_NAME } from "../../src/checks/index.ts";
import { MODULES, moduleOfCheck, resolveSelection } from "../../src/checks/modules.ts";

describe("MODULES completeness", () => {
  it("every check in ALL_CHECKS_BY_NAME belongs to exactly one module", () => {
    const fromModules = Object.values(MODULES)
      .flatMap((m) => m.checks)
      .sort();
    const fromRegistry = Object.keys(ALL_CHECKS_BY_NAME).sort();
    expect(fromModules).toEqual(fromRegistry);
  });

  it("no check is listed in more than one module", () => {
    const seen = new Map<string, string>();
    for (const mod of Object.values(MODULES)) {
      for (const check of mod.checks) {
        const owner = seen.get(check);
        expect(owner, `"${check}" listed in both "${owner}" and "${mod.name}"`).toBeUndefined();
        seen.set(check, mod.name);
      }
    }
  });
});

describe("moduleOfCheck", () => {
  it("resolves a known check to its module", () => {
    expect(moduleOfCheck("cache-coverage")).toBe("cache");
    expect(moduleOfCheck("purchase-journey-flow")).toBe("e2e");
    expect(moduleOfCheck("html-structural-diff")).toBe("html");
  });

  it("returns undefined for an unknown check", () => {
    expect(moduleOfCheck("not-a-real-check")).toBeUndefined();
  });
});

describe("resolveSelection", () => {
  it("returns all 8 modules + all checks + all flows when neither only nor skip is given", () => {
    const result = resolveSelection({});
    expect(result.modules.sort()).toEqual(Object.keys(MODULES).sort());
    expect([...result.checkNames].sort()).toEqual(Object.keys(ALL_CHECKS_BY_NAME).sort());
    const allFlows = new Set(Object.values(MODULES).flatMap((m) => m.flows));
    expect([...result.flows].sort()).toEqual([...allFlows].sort());
    expect(result.errors).toEqual([]);
  });

  it("--only narrows to just the named modules", () => {
    const result = resolveSelection({ only: "e2e,html" });
    expect(result.modules.sort()).toEqual(["e2e", "html"]);
    expect([...result.checkNames].sort()).toEqual(
      [...MODULES.e2e.checks, ...MODULES.html.checks].sort(),
    );
    expect(result.errors).toEqual([]);
  });

  it("--skip subtracts from the full set when --only is absent", () => {
    const result = resolveSelection({ skip: "visual,vitals" });
    expect(result.modules).not.toContain("visual");
    expect(result.modules).not.toContain("vitals");
    expect(result.modules.length).toBe(Object.keys(MODULES).length - 2);
  });

  it("--only + --skip together: only is the base, skip subtracts from it", () => {
    const result = resolveSelection({ only: "e2e,html,console", skip: "console" });
    expect(result.modules.sort()).toEqual(["e2e", "html"]);
  });

  it("check:<name> in --only adds a single check even if its module is excluded", () => {
    const result = resolveSelection({ only: "html,check:cache-coverage" });
    expect(result.modules).toEqual(["html"]);
    expect(result.checkNames.has("cache-coverage")).toBe(true);
    expect(result.checkNames.has("html-structural-diff")).toBe(true);
  });

  it("check:<name> in --skip subtracts a single check", () => {
    const result = resolveSelection({ only: "html", skip: "check:lazy-section-presence" });
    expect(result.checkNames.has("lazy-section-presence")).toBe(false);
    expect(result.checkNames.has("html-structural-diff")).toBe(true);
  });

  it("unknown module name is reported in errors, not thrown", () => {
    const result = resolveSelection({ only: "not-a-module" });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/unknown module/);
  });

  it("unknown check:<name> is reported in errors", () => {
    const result = resolveSelection({ only: "check:not-a-real-check" });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/unknown check/);
  });
});
