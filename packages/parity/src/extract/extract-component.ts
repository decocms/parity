import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright";
import { captureSectionArtifacts, captureSectionScreenshot } from "../engine/section-capture.ts";
import type { DetectedComponent, ExtractedComponent } from "../types/extract.ts";

/**
 * Per-component extraction for `parity extract` (M5). Reuses the shared
 * `captureSectionArtifacts` (HTML + computed styles) and
 * `captureSectionScreenshot` (locator-boundingBox crop of a full-page
 * screenshot) primitives factored out of `commands/section.ts`'s
 * `gatherSide` — see `src/engine/section-capture.ts`.
 */

const LINK_CAP = 30;

export interface ExtractComponentOptions {
  outDir: string;
  index: number;
  /**
   * A full-page screenshot already taken for this page load. When
   * provided, `extractComponent` crops from it instead of taking its own
   * full-page screenshot — extracting N components from one page load
   * only pays the (expensive) full-page screenshot cost once.
   */
  pageScreenshot?: Buffer;
}

export async function extractComponent(
  page: Page,
  component: DetectedComponent,
  opts: ExtractComponentOptions,
): Promise<ExtractedComponent> {
  mkdirSync(opts.outDir, { recursive: true });

  const artifacts = await captureSectionArtifacts(page, {
    selector: component.selector,
    wantHtml: true,
    wantStyles: true,
    wantCssSource: false,
  });

  const screenshotPath = `${opts.outDir}/screenshot.png`;
  await captureSectionScreenshot(page, component.selector, screenshotPath, opts.pageScreenshot);

  const { images, backgroundImages, fonts, links, textContent } = await collectComponentDetails(
    page,
    component.selector,
  );

  const computedStyles =
    artifacts.styles && "found" in artifacts.styles && artifacts.styles.found
      ? artifacts.styles.styles
      : null;

  const extracted: ExtractedComponent = {
    role: component.role,
    selector: component.selector,
    html: artifacts.html ?? "",
    computedStyles,
    screenshotPath,
    assets: { images, backgroundImages, fonts },
    links: capLinks(links, LINK_CAP),
    textContent,
  };

  writeFileSync(`${opts.outDir}/component.html`, extracted.html, "utf8");
  writeFileSync(
    `${opts.outDir}/styles.json`,
    `${JSON.stringify(computedStyles ?? {}, null, 2)}\n`,
    "utf8",
  );

  return extracted;
}

interface RawComponentDetails {
  images: string[];
  backgroundImages: (string | null)[];
  fonts: string[];
  links: { href: string; text: string }[];
  textContent: string[];
}

async function collectComponentDetails(
  page: Page,
  selector: string,
): Promise<{
  images: string[];
  backgroundImages: string[];
  fonts: string[];
  links: { href: string; text: string }[];
  textContent: string[];
}> {
  let raw: RawComponentDetails;
  try {
    raw = await page.evaluate((sel: string) => {
      const root = document.querySelector(sel);
      if (!root) {
        return { images: [], backgroundImages: [], fonts: [], links: [], textContent: [] };
      }
      const images = new Set<string>();
      for (const img of Array.from(root.querySelectorAll("img"))) {
        const src = img.getAttribute("src");
        if (src) images.add(src);
        const srcset = img.getAttribute("srcset");
        if (srcset) {
          for (const part of srcset.split(",")) {
            const url = part.trim().split(/\s+/)[0];
            if (url) images.add(url);
          }
        }
      }

      const bgRaw: (string | null)[] = [];
      const descendants = [root, ...Array.from(root.querySelectorAll("*"))].slice(0, 200);
      for (const el of descendants) {
        const bg = window.getComputedStyle(el).getPropertyValue("background-image");
        if (bg && bg !== "none") bgRaw.push(bg);
      }

      const fonts: string[] = [];
      const fontEls = [root, ...Array.from(root.querySelectorAll("*")).slice(0, 5)];
      for (const el of fontEls) {
        const ff = window.getComputedStyle(el).getPropertyValue("font-family");
        if (ff) fonts.push(ff);
      }

      const links: { href: string; text: string }[] = [];
      for (const a of Array.from(root.querySelectorAll("a"))) {
        const href = a.getAttribute("href") ?? "";
        const text = (a.textContent ?? "").trim().replace(/\s+/g, " ");
        links.push({ href, text });
      }

      const textContent: string[] = [];
      for (const el of Array.from(
        root.querySelectorAll("h1, h2, h3, h4, p, span, button, label"),
      )) {
        const t = (el.textContent ?? "").trim().replace(/\s+/g, " ");
        if (t.length > 0 && t.length < 300) textContent.push(t);
      }

      return { images: Array.from(images), backgroundImages: bgRaw, fonts, links, textContent };
    }, selector);
  } catch {
    raw = { images: [], backgroundImages: [], fonts: [], links: [], textContent: [] };
  }

  const backgroundImages = Array.from(
    new Set(
      raw.backgroundImages
        .map((v) => parseBackgroundImageUrl(v))
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const fonts = Array.from(new Set(raw.fonts));
  const textContent = Array.from(new Set(raw.textContent)).slice(0, 100);

  return {
    images: raw.images,
    backgroundImages,
    fonts,
    links: raw.links,
    textContent,
  };
}

/**
 * Parse a CSS `background-image` computed value into a bare URL, or
 * `null` when it's `none`/a gradient/otherwise not a plain `url(...)`.
 * Isolated as a pure function (no DOM) so it's unit-testable — the
 * computed value can be a single `url("...")`, an unquoted `url(...)`,
 * or a comma-separated list (we only take the first).
 */
export function parseBackgroundImageUrl(cssValue: string | null | undefined): string | null {
  if (!cssValue) return null;
  const trimmed = cssValue.trim();
  if (trimmed === "" || trimmed === "none") return null;
  const first = trimmed.split(",")[0]?.trim();
  if (!first) return null;
  const match = first.match(/^url\((['"]?)(.*)\1\)$/i);
  if (!match) return null;
  const url = match[2]?.trim();
  return url && url.length > 0 ? url : null;
}

/**
 * Cap a link list at `max` entries. Isolated so a mega-footer with
 * hundreds of links doesn't blow up the exported bundle — testable
 * without a Page.
 */
export function capLinks<T>(links: T[], max: number): T[] {
  return links.slice(0, max);
}
