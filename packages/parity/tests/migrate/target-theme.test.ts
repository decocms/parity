import { describe, expect, it } from "vitest";
import { TARGETS, getTargetTheme, TARGET_NAMES } from "../../src/migrate/targets/index.ts";
import type { ThemeBundle } from "../../src/types/migrate.ts";

const THEME: ThemeBundle = {
  colors: {
    primary: "#0a5",
    secondary: "#f30",
    background: "#fff",
    text: "#111",
    palette: [],
  },
  typography: { fontFamilies: ["Inter", "Georgia"], sizeScale: [] },
  spacingScale: [],
  radii: ["2px", "8px", "16px"],
  shadows: ["0 1px 2px rgba(0,0,0,.1)"],
  breakpoints: ["640px", "768px", "1024px", "1280px"],
  motion: { durations: [], easings: [] },
  tokens: {},
} as unknown as ThemeBundle;

describe("target theme registry (#309)", () => {
  it("declares a starter theme for every registered target", () => {
    // The bug this replaces: theme generation was hardcoded to one target, so the others silently
    // produced nothing. A target may legitimately have no theme — but it has to be visible here,
    // not an omission in a caller.
    const missing = TARGET_NAMES.filter((name) => !getTargetTheme(name));
    expect(missing).toEqual([]);
  });

  it("gives FastStore v4 SCSS, because @faststore/cli mandates the --fs-* contract", () => {
    const t = getTargetTheme("faststore-v4");
    expect(t?.filename).toBe("custom-theme.scss");
    const out = t?.build(THEME) ?? "";
    expect(out).toContain("--fs-");
    expect(out).not.toContain("@theme");
  });

  it("gives the Tailwind targets a @theme block", () => {
    for (const name of ["faststore-next", "tanstack-deco"]) {
      const t = getTargetTheme(name);
      expect(t?.filename, name).toBe("theme.css");
      const out = t?.build(THEME) ?? "";
      expect(out, name).toContain("@theme {");
      expect(out, name).toContain("--color-brand-primary: #0a5;");
    }
  });

  it("names the command that produced the file, so the header is not misleading", () => {
    expect(getTargetTheme("faststore-next")?.build(THEME)).toContain("--target faststore-next");
    expect(getTargetTheme("tanstack-deco")?.build(THEME)).toContain("--target tanstack-deco");
  });

  it("tells the Deco target to reconcile rather than drop the file in", () => {
    const out = getTargetTheme("tanstack-deco")?.build(THEME) ?? "";
    // Three parallel token sets is the failure mode worth warning about up front.
    expect(out).toContain("Reconcile");
  });

  it("keeps the aliases pointing at the same target object", () => {
    expect(TARGETS.faststore).toBe(TARGETS["faststore-v4"]);
    expect(TARGETS.tanstack).toBe(TARGETS["tanstack-deco"]);
  });

  it("returns null for an unknown target instead of throwing", () => {
    expect(getTargetTheme("nope")).toBeNull();
  });
});
