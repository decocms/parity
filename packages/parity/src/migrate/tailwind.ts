/**
 * Deterministic computed-CSS → Tailwind translator for `parity migrate`.
 *
 * No LLM: a computed style value is mapped to the closest EXACT Tailwind
 * default-scale utility, falling back to an arbitrary value (`text-[13px]`)
 * when there's no exact match. Deterministic = free, testable, stable across
 * runs. This is the first-class intermediate representation the migration
 * bundle carries; the raw computed styles remain only as the fallback tier.
 *
 * Exact-match (not nearest) on purpose: a "nearest" guess silently rewrites
 * `13px` to `text-sm` (14px) and the agent ships the wrong size. Arbitrary
 * values keep fidelity.
 */

/** px value → Tailwind default spacing step (used by gap/padding/margin). */
const SPACING: Record<string, string> = {
  "0px": "0",
  "2px": "0.5",
  "4px": "1",
  "6px": "1.5",
  "8px": "2",
  "10px": "2.5",
  "12px": "3",
  "14px": "3.5",
  "16px": "4",
  "20px": "5",
  "24px": "6",
  "28px": "7",
  "32px": "8",
  "36px": "9",
  "40px": "10",
  "44px": "11",
  "48px": "12",
  "56px": "14",
  "64px": "16",
  "80px": "20",
  "96px": "24",
};

const FONT_SIZE: Record<string, string> = {
  "12px": "text-xs",
  "14px": "text-sm",
  "16px": "text-base",
  "18px": "text-lg",
  "20px": "text-xl",
  "24px": "text-2xl",
  "30px": "text-3xl",
  "36px": "text-4xl",
  "48px": "text-5xl",
  "60px": "text-6xl",
  "72px": "text-7xl",
  "96px": "text-8xl",
  "128px": "text-9xl",
};

const FONT_WEIGHT: Record<string, string> = {
  "100": "font-thin",
  "200": "font-extralight",
  "300": "font-light",
  "400": "font-normal",
  "500": "font-medium",
  "600": "font-semibold",
  "700": "font-bold",
  "800": "font-extrabold",
  "900": "font-black",
};

const RADIUS: Record<string, string> = {
  "0px": "rounded-none",
  "2px": "rounded-sm",
  "4px": "rounded",
  "6px": "rounded-md",
  "8px": "rounded-lg",
  "12px": "rounded-xl",
  "16px": "rounded-2xl",
  "24px": "rounded-3xl",
  "9999px": "rounded-full",
};

const DISPLAY: Record<string, string> = {
  flex: "flex",
  "inline-flex": "inline-flex",
  grid: "grid",
  "inline-grid": "inline-grid",
  block: "block",
  "inline-block": "inline-block",
  inline: "inline",
  none: "hidden",
};

const FLEX_DIR: Record<string, string> = {
  row: "flex-row",
  "row-reverse": "flex-row-reverse",
  column: "flex-col",
  "column-reverse": "flex-col-reverse",
};

const JUSTIFY: Record<string, string> = {
  "flex-start": "justify-start",
  "flex-end": "justify-end",
  center: "justify-center",
  "space-between": "justify-between",
  "space-around": "justify-around",
  "space-evenly": "justify-evenly",
};

const ALIGN: Record<string, string> = {
  "flex-start": "items-start",
  "flex-end": "items-end",
  center: "items-center",
  baseline: "items-baseline",
  stretch: "items-stretch",
};

const TEXT_TRANSFORM: Record<string, string> = {
  uppercase: "uppercase",
  lowercase: "lowercase",
  capitalize: "capitalize",
};

const POSITION: Record<string, string> = {
  relative: "relative",
  absolute: "absolute",
  fixed: "fixed",
  sticky: "sticky",
};

const OVERFLOW: Record<string, string> = {
  hidden: "overflow-hidden",
  auto: "overflow-auto",
  scroll: "overflow-scroll",
};

/** Normalize a CSS color so it's valid inside a Tailwind arbitrary value (no spaces). */
export function normalizeColor(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

function spacingClass(prefix: string, value: string): string {
  const step = SPACING[value.trim()];
  return step !== undefined ? `${prefix}-${step}` : `${prefix}-[${value.trim()}]`;
}

/** padding/margin shorthand → utilities (1 value → all; 2 → y/x; else skip). */
function boxSpacing(prop: "p" | "m", value: string): string[] {
  const parts = value.trim().split(/\s+/);
  if (parts.length === 1 && parts[0]) return [spacingClass(prop, parts[0])];
  if (parts.length === 2 && parts[0] && parts[1]) {
    return [spacingClass(`${prop}y`, parts[0]), spacingClass(`${prop}x`, parts[1])];
  }
  // ponytail: 3-4 value shorthand skipped — rare and not worth the mapping
  // table; raw CSS fallback in the manifest still has it.
  return [];
}

function sizeClass(prefix: "w" | "h", value: string): string | null {
  const v = value.trim();
  if (v === "auto" || v === "") return null;
  if (v === "100%") return `${prefix}-full`;
  if (prefix === "w" && v === "100vw") return "w-screen";
  if (prefix === "h" && v === "100vh") return "h-screen";
  const step = SPACING[v];
  return step !== undefined ? `${prefix}-${step}` : `${prefix}-[${v}]`;
}

/** Map a color value to a theme token class when it matches, else arbitrary. */
function colorClass(
  prefix: "text" | "bg",
  value: string,
  tokenByValue: Map<string, string>,
): string | null {
  const v = value.trim();
  if (!v || v === "transparent" || v === "rgba(0, 0, 0, 0)" || v === "currentcolor") return null;
  const token = tokenByValue.get(v);
  if (token) return `${prefix}-${token}`;
  return `${prefix}-[${normalizeColor(v)}]`;
}

/**
 * Translate a computed-style record (SECTION_STYLE_KEYS subset) into a
 * deterministic list of Tailwind utilities. `themeTokens` (value → token
 * name) lets colors resolve to `bg-primary` instead of an arbitrary hex.
 */
export function stylesToTailwind(
  styles: Record<string, string>,
  themeTokens?: Record<string, string>,
): string[] {
  const tokenByValue = new Map<string, string>();
  if (themeTokens) {
    for (const [token, value] of Object.entries(themeTokens)) {
      // token map is name → value; we want value → name for reverse lookup.
      tokenByValue.set(value.trim(), token);
    }
  }

  const out: string[] = [];
  const push = (c: string | null | undefined) => {
    if (c && !out.includes(c)) out.push(c);
  };
  const g = (k: string) => (styles[k] ?? "").trim();

  const display = g("display");
  push(DISPLAY[display]);

  if (display === "flex" || display === "inline-flex") {
    push(FLEX_DIR[g("flex-direction")]);
  }
  push(JUSTIFY[g("justify-content")]);
  push(ALIGN[g("align-items")]);

  const gap = g("gap");
  if (gap && gap !== "normal") push(spacingClass("gap", gap.split(/\s+/)[0] ?? gap));

  for (const c of boxSpacing("p", g("padding"))) push(c);
  for (const c of boxSpacing("m", g("margin"))) push(c);

  push(sizeClass("w", g("width")));
  push(sizeClass("h", g("height")));

  push(FONT_SIZE[g("font-size")] ?? (g("font-size") ? `text-[${g("font-size")}]` : null));
  push(FONT_WEIGHT[g("font-weight")]);
  push(TEXT_TRANSFORM[g("text-transform")]);

  push(colorClass("text", g("color"), tokenByValue));
  push(colorClass("bg", g("background-color"), tokenByValue));

  const radius = g("border-radius");
  if (radius) push(RADIUS[radius] ?? `rounded-[${radius}]`);

  const shadow = g("box-shadow");
  // ponytail: box-shadow has no clean 1:1 default-scale inverse — emit a
  // presence marker; the agent refines from the raw value if it matters.
  if (shadow && shadow !== "none") push("shadow");

  push(POSITION[g("position")]);
  push(OVERFLOW[g("overflow")]);

  return out;
}
