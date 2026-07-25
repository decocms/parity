import { writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import type { Page } from "playwright";
import { traceLoadedPage } from "../commands/css-trace.ts";
import { cropPngBuffer } from "./capture-utils.ts";
import {
  type ComputedStylesNotFound,
  type ComputedStylesResult,
  SECTION_STYLE_KEYS,
  readComputedStyles,
} from "./computed-styles.ts";
import { type CssSource, resolveFromTrace } from "./css-source-resolver.ts";

/**
 * Single-selector capture primitive, extracted out of `commands/section.ts`'s
 * `gatherSide` (M5 / parity extract) so both the prod×cand diff path
 * (`section`/`fix`) and the new single-site `extract` path can read
 * HTML/computed-styles/CSS-source for one selector on an ALREADY NAVIGATED
 * AND STABILIZED page without duplicating the read logic.
 *
 * Deliberately does NOT own navigation, `stabilizeCarousels`, or the
 * lazy-load scroll/skeleton-settle dance — those stay in the caller because
 * they're a PAGE-level concern (run once per page load), while this
 * function is a PER-SELECTOR concern (run once per section/component on
 * that same page). `gatherSide` calls this once per side; `extractComponent`
 * calls it once per detected component on the same page.
 */
export interface SectionArtifacts {
  html: string | null;
  htmlError?: string;
  styles: ComputedStylesResult | ComputedStylesNotFound | null;
  /** Map<property, CssSource | null> when `wantCssSource` was on. */
  cssSources?: Map<string, CssSource | null>;
  cssSourceError?: string;
}

export interface CaptureSectionArtifactsOptions {
  selector: string;
  wantHtml: boolean;
  wantStyles: boolean;
  wantCssSource: boolean;
  /** Needed only when `wantCssSource` is on — CDP tracing re-navigates via `traceLoadedPage`. */
  url?: string;
}

export async function captureSectionArtifacts(
  page: Page,
  opts: CaptureSectionArtifactsOptions,
): Promise<SectionArtifacts> {
  const result: SectionArtifacts = { html: null, styles: null };

  if (opts.wantHtml) {
    try {
      const fullHtml = await page.content();
      const $ = cheerio.load(fullHtml);
      const matches = $(opts.selector);
      if (matches.length === 0) {
        result.htmlError = `seletor '${opts.selector}' não casou nenhum elemento`;
      } else {
        result.html = $.html(matches.first());
      }
    } catch (err) {
      result.htmlError = `falha lendo HTML: ${(err as Error).message}`;
    }
  }

  if (opts.wantStyles) {
    result.styles = await readComputedStyles(page, opts.selector);
  }

  if (opts.wantCssSource) {
    try {
      const trace = await traceLoadedPage(page, opts.url ?? page.url(), opts.selector);
      if (trace.found) {
        result.cssSources = resolveFromTrace(trace, SECTION_STYLE_KEYS);
      } else {
        result.cssSourceError = `tracePage não encontrou '${opts.selector}'`;
      }
    } catch (err) {
      result.cssSourceError = `tracePage falhou: ${(err as Error).message}`;
    }
  }

  return result;
}

/**
 * Screenshot of a single selector.
 *
 * Two modes:
 *  - Default (section/fix): `locator.screenshot()` — isolates the element
 *    directly. The page's CSS (Tailwind JIT, @media, resets) is already
 *    applied at capture time, so nothing is lost; and unlike full-page+crop
 *    it can't mis-slice below-fold sections or fixed/absolute overlays
 *    (megamenu panel, minicart drawer). The old full-page+crop approach
 *    cropped in document space using viewport-relative `boundingBox()`
 *    coords, so a scrolled-to element (e.g. the footer) grabbed the TOP of
 *    the page instead. Element screenshot sidesteps that entirely.
 *  - `preCapturedFullPng` (extract): many crops from ONE full-page PNG — keep
 *    cropping, since re-screenshotting per selector would be wasteful there.
 */
export async function captureSectionScreenshot(
  page: Page,
  selector: string,
  outPath: string,
  preCapturedFullPng?: Buffer,
): Promise<string | null> {
  try {
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) {
      return `seletor '${selector}' não casou nenhum elemento`;
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);

    if (preCapturedFullPng) {
      const box = await loc.boundingBox({ timeout: 3_000 });
      if (!box || box.width <= 0 || box.height <= 0) {
        return `seletor '${selector}' não tem boundingBox visível`;
      }
      const cropped = cropPngBuffer(preCapturedFullPng, box);
      await writeFile(outPath, cropped);
      return null;
    }

    const box = await loc.boundingBox({ timeout: 3_000 });
    if (!box || box.width <= 0 || box.height <= 0) {
      return `seletor '${selector}' não tem boundingBox visível`;
    }
    await loc.screenshot({ path: outPath, animations: "disabled", timeout: 15_000 });
    return null;
  } catch (err) {
    return `falha no screenshot: ${(err as Error).message}`;
  }
}
