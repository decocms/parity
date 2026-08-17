/**
 * Phase 1 of `parity migrate` — site-wide theme extraction.
 *
 * `scrapeThemeSamples` runs one in-page pass collecting color / typography /
 * spacing signals; `aggregateTheme` is a pure function that elects the
 * primary/secondary/background/text colors and builds the token map + scales.
 * The split keeps the election logic (the part with real heuristics) testable
 * without a browser.
 */

import type { Page } from "playwright";
import type { ThemeBundle, ThemeColor } from "../types/migrate.ts";

export interface RawThemeSamples {
  bodyBackground: string;
  bodyText: string;
  bodyFontFamily: string;
  /** Text colors across sampled elements. */
  colors: string[];
  /** Non-transparent background colors across sampled elements. */
  backgrounds: string[];
  /** Backgrounds of interactive elements (buttons/links/[role=button]) — primary election. */
  interactiveBackgrounds: string[];
  fontFamilies: string[];
  fontSizes: string[];
  radii: string[];
  shadows: string[];
  /** gap + single-value padding values, for the spacing scale. */
  spacings: string[];
  /** Breakpoint widths (px) parsed from @media rules. */
  breakpoints: string[];
  /** transition/animation durations across sampled elements. */
  motionDurations: string[];
  /** transition/animation timing functions. */
  motionEasings: string[];
}

const TRANSPARENT = new Set(["transparent", "rgba(0, 0, 0, 0)", "rgba(0,0,0,0)"]);

/** Parse `rgb(...)`/`rgba(...)` into channels, or null when unparseable. */
export function parseRgb(color: string): { r: number; g: number; b: number; a: number } | null {
  const m = color.trim().match(/rgba?\(([^)]+)\)/i);
  if (!m || !m[1]) return null;
  const parts = m[1].split(",").map((p) => Number.parseFloat(p.trim()));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
}

/** A color is "neutral" (white/black/gray) and thus a poor primary candidate. */
export function isNeutral(color: string): boolean {
  const c = parseRgb(color);
  if (!c) return false;
  if (c.a < 0.1) return true;
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  // Low chroma → grayscale. Also catches near-white and near-black.
  return max - min < 18;
}

function rank(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key = v.trim();
    if (!key || TRANSPARENT.has(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

/** Reject junk font-family values (e.g. VTEX responsive query-string hacks). */
export function isPlausibleFontFamily(f: string): boolean {
  const v = f.trim();
  return v.length > 0 && v.length < 120 && !v.includes("=") && !v.includes("&");
}

function sortByPx(values: string[]): string[] {
  const uniq = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  return uniq.sort((a, b) => (Number.parseFloat(a) || 0) - (Number.parseFloat(b) || 0));
}

/**
 * Merge raw samples from multiple viewports into one before election.
 * Responsive sites expose different colors/spacings per viewport; pooling the
 * samples gives a fuller, more confident palette/scale. Body-level fields take
 * the first viewport (they don't vary meaningfully).
 */
export function mergeRawThemeSamples(list: RawThemeSamples[]): RawThemeSamples {
  const first = list[0]!;
  const concat = (key: keyof RawThemeSamples): string[] =>
    list.flatMap((s) => s[key] as string[]);
  return {
    bodyBackground: first.bodyBackground,
    bodyText: first.bodyText,
    bodyFontFamily: first.bodyFontFamily,
    colors: concat("colors"),
    backgrounds: concat("backgrounds"),
    interactiveBackgrounds: concat("interactiveBackgrounds"),
    fontFamilies: concat("fontFamilies"),
    fontSizes: concat("fontSizes"),
    radii: concat("radii"),
    shadows: concat("shadows"),
    spacings: concat("spacings"),
    breakpoints: concat("breakpoints"),
    motionDurations: concat("motionDurations"),
    motionEasings: concat("motionEasings"),
  };
}

/** A color is opaque enough to be a brand token (not a translucent overlay). */
export function isOpaque(color: string): boolean {
  const c = parseRgb(color);
  // Non-rgb (hex/named) → assume opaque; rgba with low alpha → translucent.
  return !c || c.a >= 0.5;
}

/** Pure theme election over raw samples. Testable without a browser. */
export function aggregateTheme(raw: RawThemeSamples): ThemeBundle {
  // Palette: text + background colors, frequency-ranked.
  const paletteRanked = rank([...raw.colors, ...raw.backgrounds]);

  // Primary: most frequent NON-neutral, OPAQUE color across ALL usages
  // (text/border/bg + interactive), not just interactive backgrounds — brands
  // often express their color as text/border (outlined CTAs), and a translucent
  // hover overlay must never win primary (e.g. Electrolux's rgba(123,138,156,.24)).
  const chromaticRanked = rank([
    ...raw.colors,
    ...raw.backgrounds,
    ...raw.interactiveBackgrounds,
  ]);
  const chromatic = [...chromaticRanked.keys()].filter((c) => !isNeutral(c) && isOpaque(c));
  const primary = chromatic[0] ?? null;
  const secondary = chromatic.find((c) => c !== primary) ?? null;

  const tokens: Record<string, string> = {};
  if (primary) tokens.primary = primary;
  if (secondary) tokens.secondary = secondary;
  if (raw.bodyBackground && !TRANSPARENT.has(raw.bodyBackground.trim()))
    tokens.background = raw.bodyBackground.trim();
  if (raw.bodyText) tokens.text = raw.bodyText.trim();

  const palette: ThemeColor[] = [...paletteRanked.entries()].map(([value, count]) => ({
    value,
    count,
    token:
      Object.entries(tokens).find(([, v]) => v === value)?.[0] ??
      (isNeutral(value) ? "neutral" : "accent"),
  }));

  return {
    colors: {
      primary,
      secondary,
      background: tokens.background ?? null,
      text: tokens.text ?? null,
      palette,
    },
    typography: {
      fontFamilies: [...rank(raw.fontFamilies).keys()].filter(isPlausibleFontFamily),
      sizeScale: sortByPx(raw.fontSizes),
    },
    spacingScale: sortByPx(raw.spacings),
    radii: sortByPx(raw.radii).filter((r) => r !== "0px"),
    shadows: [...new Set(raw.shadows.map((s) => s.trim()))].filter((s) => s && s !== "none"),
    breakpoints: sortByPx(raw.breakpoints),
    motion: {
      durations: [...new Set(raw.motionDurations.map((d) => d.trim()))].filter(
        (d) => d && d !== "0s" && d !== "0ms",
      ),
      easings: [...new Set(raw.motionEasings.map((e) => e.trim()))].filter(
        (e) => e && e !== "ease" && e !== "linear",
      ),
    },
    tokens,
  };
}

/** Collect raw theme samples from a live page (Phase 1). */
export async function scrapeThemeSamples(page: Page): Promise<RawThemeSamples> {
  return page.evaluate(() => {
    const cap = 2000;
    const els = Array.from(document.querySelectorAll<HTMLElement>("*")).slice(0, cap);
    const colors: string[] = [];
    const backgrounds: string[] = [];
    const interactiveBackgrounds: string[] = [];
    const fontFamilies: string[] = [];
    const fontSizes: string[] = [];
    const radii: string[] = [];
    const shadows: string[] = [];
    const spacings: string[] = [];
    const motionDurations: string[] = [];
    const motionEasings: string[] = [];
    const transparent = new Set(["transparent", "rgba(0, 0, 0, 0)"]);

    for (const el of els) {
      const cs = getComputedStyle(el);
      colors.push(cs.color);
      const bg = cs.backgroundColor;
      if (!transparent.has(bg)) backgrounds.push(bg);
      fontFamilies.push(cs.fontFamily);
      fontSizes.push(cs.fontSize);
      if (cs.borderRadius) radii.push(cs.borderRadius);
      if (cs.boxShadow && cs.boxShadow !== "none") shadows.push(cs.boxShadow);
      if (cs.gap && cs.gap !== "normal") spacings.push(cs.gap.split(/\s+/)[0] ?? cs.gap);
      const pad = cs.padding.split(/\s+/);
      if (pad.length === 1 && pad[0] && pad[0] !== "0px") spacings.push(pad[0]);

      for (const d of cs.transitionDuration.split(",")) if (d.trim()) motionDurations.push(d.trim());
      for (const d of cs.animationDuration.split(",")) if (d.trim()) motionDurations.push(d.trim());
      for (const e of cs.transitionTimingFunction.split(","))
        if (e.trim()) motionEasings.push(e.trim());

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const isInteractive = tag === "button" || tag === "a" || role === "button";
      if (isInteractive && !transparent.has(bg)) interactiveBackgrounds.push(bg);
    }

    // Breakpoints: parse min/max-width px from @media rules across stylesheets.
    const breakpoints: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = (sheet as CSSStyleSheet).cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        const media = (rule as CSSMediaRule).media?.mediaText;
        if (!media) continue;
        const re = /(?:min|max)-width:\s*(\d+(?:\.\d+)?)px/g;
        let m: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
        while ((m = re.exec(media)) !== null) breakpoints.push(`${m[1]}px`);
      }
    }

    const body = getComputedStyle(document.body);
    return {
      bodyBackground: getComputedStyle(document.documentElement).backgroundColor || body.backgroundColor,
      bodyText: body.color,
      bodyFontFamily: body.fontFamily,
      colors,
      backgrounds,
      interactiveBackgrounds,
      fontFamilies,
      fontSizes,
      radii,
      shadows,
      spacings,
      breakpoints,
      motionDurations,
      motionEasings,
    };
  });
}
