import type { Page } from "playwright";

/**
 * Computed-style helper for `parity section` (issue #31, PR 3).
 *
 * Picks a curated subset of CSS properties that actually matter when comparing
 * how a section is RENDERED — not the long-tail of inherited / browser-default
 * values that would just bloat the diff. The lift on "Flash Sale section is
 * `visible=true` but actually invisible" was specifically `z-index` + `opacity`
 * + `transform`, so the list leans toward visibility / layout / positioning.
 *
 * Exported so other commands (e.g. a future `parity layout`) can reuse the
 * same list and get a consistent diff vocabulary.
 */
export const SECTION_STYLE_KEYS: ReadonlyArray<string> = [
  // Visibility — the classic "I'm in the DOM but you can't see me" group.
  "display",
  "visibility",
  "opacity",
  // Positioning + stacking.
  "position",
  "z-index",
  "top",
  "right",
  "bottom",
  "left",
  // Box dimensions — catches mis-sized banner / wrong-variant rendering.
  "width",
  "height",
  "max-width",
  "max-height",
  "min-width",
  "min-height",
  // Transform/clip — common culprits for hidden-but-visible bugs.
  "transform",
  "clip-path",
  "overflow",
  "overflow-x",
  "overflow-y",
  // Box model.
  "margin",
  "padding",
  "border",
  // Typography (just enough to catch the obvious).
  "font-size",
  "font-weight",
  "color",
  "background-color",
  "background-image",
  // Layout primitives we use a lot in Deco sections.
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
  "grid-template-columns",
  "grid-template-rows",
];

export interface ComputedStylesResult {
  /** Match found and styles read successfully. */
  found: true;
  /** Selected styles, in the order of SECTION_STYLE_KEYS. */
  styles: Record<string, string>;
  /** Bounding-client-rect of the matched element — width 0 / height 0 is a strong "invisible" signal. */
  rect: { x: number; y: number; width: number; height: number } | null;
  /** True if the browser thought the element was offscreen / display:none. */
  hiddenByPlaywright: boolean;
}

export interface ComputedStylesNotFound {
  found: false;
  error: string;
}

/**
 * Read SECTION_STYLE_KEYS from the first element matching `selector` in
 * `page`. Returns an explicit `found: false` (not a throw) so callers can
 * compose prod/cand reads concurrently without unwinding promises.
 *
 * The keys list is passed to the page so future additions to
 * SECTION_STYLE_KEYS just propagate — no code change inside the eval.
 */
export async function readComputedStyles(
  page: Page,
  selector: string,
): Promise<ComputedStylesResult | ComputedStylesNotFound> {
  const keys = SECTION_STYLE_KEYS as string[];
  let exists = false;
  try {
    exists = (await page.locator(selector).count()) > 0;
  } catch (err) {
    return { found: false, error: `seletor inválido: ${(err as Error).message}` };
  }
  if (!exists) {
    return { found: false, error: `seletor '${selector}' não casou nenhum elemento` };
  }
  // Visibility shortcut — Playwright's `isVisible` already accounts for
  // display:none / visibility:hidden / 0×0 box. Useful diagnostic.
  const hiddenByPlaywright = !(await page
    .locator(selector)
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false));

  const got = await page.evaluate(
    ({ sel, keys }) => {
      const el = document.querySelector(sel);
      if (!el || !(el instanceof HTMLElement)) {
        return { ok: false as const };
      }
      const cs = window.getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const k of keys) out[k] = cs.getPropertyValue(k) || "";
      const r = el.getBoundingClientRect();
      return {
        ok: true as const,
        styles: out,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    },
    { sel: selector, keys },
  );

  if (!got.ok) {
    return { found: false, error: `seletor '${selector}' não casou após o eval (DOM mudou)` };
  }
  return { found: true, styles: got.styles, rect: got.rect, hiddenByPlaywright };
}
