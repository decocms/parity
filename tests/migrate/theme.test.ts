import { describe, expect, it } from "vitest";
import {
  aggregateTheme,
  isNeutral,
  isPlausibleFontFamily,
  parseRgb,
  type RawThemeSamples,
} from "../../src/migrate/theme.ts";

function raw(overrides: Partial<RawThemeSamples> = {}): RawThemeSamples {
  return {
    bodyBackground: "rgb(255, 255, 255)",
    bodyText: "rgb(17, 17, 17)",
    bodyFontFamily: "Inter, sans-serif",
    colors: ["rgb(17, 17, 17)", "rgb(17, 17, 17)", "rgb(228, 0, 43)"],
    backgrounds: ["rgb(255, 255, 255)", "rgb(255, 255, 255)"],
    interactiveBackgrounds: ["rgb(228, 0, 43)", "rgb(228, 0, 43)", "rgb(0, 90, 200)", "rgb(255, 255, 255)"],
    fontFamilies: ["Inter, sans-serif", "Inter, sans-serif", "Georgia, serif"],
    fontSizes: ["16px", "14px", "16px", "24px"],
    radii: ["0px", "8px", "8px"],
    shadows: ["none", "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px"],
    spacings: ["8px", "16px", "8px"],
    breakpoints: ["768px", "1024px", "768px", "40px"],
    motionDurations: ["0s", "0.2s", "300ms", "0.2s"],
    motionEasings: ["ease", "cubic-bezier(0.4, 0, 0.2, 1)"],
    ...overrides,
  };
}

describe("aggregateTheme", () => {
  it("elects primary/secondary from non-neutral interactive backgrounds", () => {
    const t = aggregateTheme(raw());
    expect(t.colors.primary).toBe("rgb(228, 0, 43)"); // most frequent chromatic
    expect(t.colors.secondary).toBe("rgb(0, 90, 200)");
    expect(t.colors.background).toBe("rgb(255, 255, 255)");
    expect(t.colors.text).toBe("rgb(17, 17, 17)");
    expect(t.tokens.primary).toBe("rgb(228, 0, 43)");
  });

  it("builds sorted scales and drops noise (0px radius, 'none' shadow)", () => {
    const t = aggregateTheme(raw());
    expect(t.typography.sizeScale).toEqual(["14px", "16px", "24px"]);
    expect(t.spacingScale).toEqual(["8px", "16px"]);
    expect(t.radii).toEqual(["8px"]);
    expect(t.shadows).toEqual(["rgba(0, 0, 0, 0.1) 0px 1px 2px 0px"]);
    expect(t.typography.fontFamilies[0]).toBe("Inter, sans-serif");
  });

  it("filters junk font-family values (VTEX responsive hack)", () => {
    const t = aggregateTheme(
      raw({ fontFamilies: ["Inter, sans-serif", "small=0em&medium=47em", "Georgia, serif"] }),
    );
    expect(t.typography.fontFamilies).toEqual(["Inter, sans-serif", "Georgia, serif"]);
  });

  it("extracts sorted breakpoints and non-default motion tokens", () => {
    const t = aggregateTheme(raw());
    expect(t.breakpoints).toEqual(["40px", "768px", "1024px"]);
    expect(t.motion.durations).toEqual(["0.2s", "300ms"]); // 0s dropped
    expect(t.motion.easings).toEqual(["cubic-bezier(0.4, 0, 0.2, 1)"]); // "ease" dropped
  });

  it("returns null primary when every interactive bg is neutral", () => {
    const t = aggregateTheme(raw({ interactiveBackgrounds: ["rgb(255, 255, 255)", "rgb(0, 0, 0)"] }));
    expect(t.colors.primary).toBeNull();
    expect(t.colors.secondary).toBeNull();
  });
});

describe("isNeutral / parseRgb", () => {
  it("flags white, black and grays as neutral", () => {
    expect(isNeutral("rgb(255, 255, 255)")).toBe(true);
    expect(isNeutral("rgb(0, 0, 0)")).toBe(true);
    expect(isNeutral("rgb(120, 122, 121)")).toBe(true);
  });
  it("keeps chromatic colors", () => {
    expect(isNeutral("rgb(228, 0, 43)")).toBe(false);
  });
  it("treats fully transparent as neutral", () => {
    expect(isNeutral("rgba(0, 0, 0, 0)")).toBe(true);
  });
  it("parseRgb handles rgb and rgba", () => {
    expect(parseRgb("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseRgb("rgba(1, 2, 3, 0.5)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseRgb("not-a-color")).toBeNull();
  });
  it("isPlausibleFontFamily rejects query-string hacks", () => {
    expect(isPlausibleFontFamily("Inter, sans-serif")).toBe(true);
    expect(isPlausibleFontFamily("small=0em&medium=47em")).toBe(false);
  });
});
