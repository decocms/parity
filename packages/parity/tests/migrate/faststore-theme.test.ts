import { describe, expect, it } from "vitest";
import { buildFastStoreTheme, pickBreakpointTiers } from "../../src/migrate/targets/faststore.ts";
import type { ThemeBundle } from "../../src/types/migrate.ts";

function theme(overrides: Partial<ThemeBundle> = {}): ThemeBundle {
  return {
    colors: {
      primary: "rgb(228, 0, 43)",
      secondary: "rgb(0, 90, 200)",
      background: "rgb(255, 255, 255)",
      text: "rgb(17, 17, 17)",
      palette: [],
    },
    typography: { fontFamilies: ["Inter, sans-serif", "Georgia, serif"], sizeScale: ["16px"] },
    spacingScale: ["8px", "16px"],
    radii: ["4px", "8px", "12px"],
    shadows: ["rgba(0,0,0,0.1) 0 1px 2px"],
    breakpoints: ["640px", "768px", "1024px", "1280px"],
    motion: { durations: ["0.2s"], easings: [] },
    tokens: {},
    ...overrides,
  };
}

describe("buildFastStoreTheme", () => {
  it("maps brand tokens to --fs-* inside .theme", () => {
    const scss = buildFastStoreTheme(theme());
    expect(scss).toContain(".theme {");
    expect(scss).toContain("--fs-color-primary-bkg: rgb(228, 0, 43);");
    expect(scss).toContain("--fs-color-accent-0: rgb(0, 90, 200);");
    expect(scss).toContain("--fs-color-text: rgb(17, 17, 17);");
    expect(scss).toContain("--fs-color-body-bkg: rgb(255, 255, 255);");
    expect(scss).toContain("--fs-text-face-body: Inter, sans-serif;");
    expect(scss).toContain("--fs-text-face-title: Georgia, serif;");
    expect(scss).toContain("--fs-border-radius-medium: 8px;"); // median of 3 radii
    expect(scss).toContain("--fs-grid-breakpoint-phone: 640px;");
    expect(scss).toContain("--fs-grid-breakpoint-desktop: 1280px;");
  });

  it("does NOT override structural spacing/text-size scales", () => {
    const scss = buildFastStoreTheme(theme());
    expect(scss).not.toContain("--fs-spacing-");
    expect(scss).not.toContain("--fs-text-size-");
  });

  it("picks breakpoint tiers by nearest-canonical, not the 4 smallest", () => {
    // Mobile-cluster noise + real tiers.
    const tiers = pickBreakpointTiers(["320px", "340px", "425px", "768px", "1024px", "1280px"]);
    expect(tiers.tablet).toBe("768px");
    expect(tiers.notebook).toBe("1024px");
    expect(tiers.desktop).toBe("1280px");
    // phone gets the nearest-to-480 remaining (425px), not 320.
    expect(tiers.phone).toBe("425px");
  });

  it("omits tokens with no value", () => {
    const scss = buildFastStoreTheme(theme({ colors: { primary: null, secondary: null, background: null, text: null, palette: [] } }));
    expect(scss).not.toContain("--fs-color-primary-bkg");
  });
});
