import type { Page } from "playwright";
import type { PageCapture } from "../../types/schema.ts";
import { capturePage } from "../collect.ts";
import type { FlowContext } from "./shared.ts";
import { findCategoryUrl, findProductUrl, screenshotPath, withCap } from "./shared.ts";

export async function flowHomepage(ctx: FlowContext): Promise<PageCapture[]> {
  const page = await ctx.ctx.newPage();
  try {
    const cap = await capturePage(page, {
      url: ctx.baseUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "home"),
    });
    return [cap];
  } finally {
    await page.close();
  }
}

export async function flowPlp(ctx: FlowContext): Promise<PageCapture[]> {
  const home = await ctx.ctx.newPage();
  const homeCap = await capturePage(home, {
    url: ctx.baseUrl,
    side: ctx.side,
    viewport: ctx.viewport,
    screenshotPath: screenshotPath(ctx, "home"),
  });
  const plpHit = ctx.rc.plpUrlHint
    ? { url: new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString(), selector: "__hint__" }
    : await findCategoryUrl(home, ctx);
  await home.close();

  if (!plpHit) return [homeCap];

  const plp = await ctx.ctx.newPage();
  try {
    const cap = await capturePage(plp, {
      url: plpHit.url,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "plp"),
    });
    return [homeCap, cap];
  } finally {
    await plp.close();
  }
}

export async function flowPdp(ctx: FlowContext): Promise<PageCapture[]> {
  const pages: PageCapture[] = [];
  const home = await ctx.ctx.newPage();
  pages.push(
    await capturePage(home, {
      url: ctx.baseUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "home"),
    }),
  );
  const plpHit = ctx.rc.plpUrlHint
    ? { url: new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString(), selector: "__hint__" }
    : await findCategoryUrl(home, ctx);
  await home.close();
  if (!plpHit) return pages;

  const plp = await ctx.ctx.newPage();
  pages.push(
    await capturePage(plp, {
      url: plpHit.url,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "plp"),
    }),
  );
  const pdpHit = await findProductUrl(plp, ctx);
  await plp.close();
  if (!pdpHit) return pages;

  const pdp = await ctx.ctx.newPage();
  try {
    pages.push(
      await capturePage(pdp, {
        url: pdpHit.url,
        side: ctx.side,
        viewport: ctx.viewport,
        screenshotPath: screenshotPath(ctx, "pdp"),
      }),
    );
    return pages;
  } finally {
    await pdp.close();
  }
}

/**
 * Step through the page in chunks to trigger IntersectionObserver-based lazy
 * hydration (Deco f-partial, Fresh islands with `threshold` triggers, etc).
 * Variant pickers are commonly rendered this way and aren't in the DOM
 * immediately after navigation.
 */
export async function scrollPageInChunks(page: Page): Promise<void> {
  await page
    .evaluate(async () => {
      const height = document.body.scrollHeight;
      const stops = [0.2, 0.4, 0.6, 0.8, 1.0, 0.4];
      for (const frac of stops) {
        window.scrollTo({ top: height * frac, behavior: "instant" as ScrollBehavior });
        await new Promise((r) => setTimeout(r, 300));
      }
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    })
    .catch(() => undefined);
  await page.waitForTimeout(1_200);
}

const PRODUCT_CARD_HEURISTIC_SELECTORS: string[] = [
  // Most specific first — these almost never false-positive
  "[data-product-card]",
  "[data-testid='product-card']",
  "[data-deco='view-product']",
  "[data-product-id]",
  "article[itemtype*='Product' i]",
  // VTEX Intelligent Search
  "[class*='galleryItem' i]",
  "[class*='gallery-layout-container'] article",
  // Generic fallbacks — only used if nothing more specific hit
  ".shelf-item",
  ".product-card",
];

/**
 * Heuristic DOM count of product cards visible on a results page.
 *
 * The selectors above progress from "specific platform marker" → "generic class
 * name". We pick the FIRST selector that returns >0 matches and trust that one
 * (instead of `max`), because the more specific selectors anchor to platform
 * convention and won't drift into recommendations carousels the way an
 * `a[href*='/p/']` would.
 */
export async function countProductCards(page: Page): Promise<number> {
  for (const sel of PRODUCT_CARD_HEURISTIC_SELECTORS) {
    const count = await withCap(
      page
        .locator(sel)
        .count()
        .catch(() => 0),
      1_500,
      0,
    );
    if (count > 0) return count;
  }
  return 0;
}
