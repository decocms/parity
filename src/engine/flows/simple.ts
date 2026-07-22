import type { Page } from "playwright";
import { hrefOverlap, urlGainedPageIndicator } from "../../checks/lib/pagination-overlap.ts";
import type { PageCapture, StepCapture } from "../../types/schema.ts";
import { capturePage } from "../collect.ts";
import type { FlowContext, FlowResult } from "./shared.ts";
import {
  collectCandidateLinks,
  findCategoryUrl,
  findProductUrl,
  firstVisibleLocator,
  screenshotPath,
  screenshotStable,
  selFor,
  withCap,
} from "./shared.ts";

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

export type PaginationMode = "page-link" | "load-more" | "infinite-scroll" | "none";

/**
 * Pure classifier: given the three boolean-ish signals a PLP can offer for
 * "how does this site get to more products", pick a mode. Kept separate
 * from the Playwright probing (`detectPaginationMode` below) so the
 * decision logic is unit-testable without a browser.
 */
export function classifyPaginationMode(signals: {
  hasNextLink: boolean;
  hasLoadMoreButton: boolean;
  countGrewOnScroll: boolean;
}): PaginationMode {
  if (signals.hasNextLink) return "page-link";
  if (signals.hasLoadMoreButton) return "load-more";
  if (signals.countGrewOnScroll) return "infinite-scroll";
  return "none";
}

/**
 * Pure pass/fail for the `verify-pagination` step, given the before/after
 * product hrefs and (for page-link mode) the before/after URL. Extracted
 * so the verdict logic can be unit tested directly.
 */
export function verifyPaginationResult(params: {
  mode: PaginationMode;
  before: string[];
  after: string[];
  urlBefore: string;
  urlAfter: string;
}): { ok: boolean; overlap: number } {
  const overlap = hrefOverlap(params.before, params.after);
  if (params.mode === "page-link") {
    const urlChanged = urlGainedPageIndicator(params.urlBefore, params.urlAfter);
    return { ok: urlChanged && overlap < 0.5, overlap };
  }
  // load-more / infinite-scroll: we expect strictly more items, and the
  // new items shouldn't be an exact duplicate of what was already there.
  const ok = params.after.length > params.before.length && overlap < 1;
  return { ok, overlap };
}

/**
 * Probe the live page for pagination affordances, priority order:
 * an explicit "next page" link > a "load more" button > a scroll-triggered
 * count increase (infinite scroll) > none found.
 */
async function detectPaginationMode(page: Page, ctx: FlowContext): Promise<PaginationMode> {
  const hasNextLink = !!(await firstVisibleLocator(page, selFor(ctx, "paginationNext")));
  const hasLoadMoreButton = !!(await firstVisibleLocator(page, selFor(ctx, "loadMoreButton")));
  let countGrewOnScroll = false;
  if (!hasNextLink && !hasLoadMoreButton) {
    const before = await countProductCards(page);
    await scrollPageInChunks(page);
    await page.waitForTimeout(500);
    const after = await countProductCards(page);
    countGrewOnScroll = after > before;
  }
  return classifyPaginationMode({ hasNextLink, hasLoadMoreButton, countGrewOnScroll });
}

export async function flowPlp(ctx: FlowContext): Promise<FlowResult> {
  const steps: StepCapture[] = [];
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

  if (!plpHit) return { pages: [homeCap], steps };

  const plp = await ctx.ctx.newPage();
  try {
    const cap = await capturePage(plp, {
      url: plpHit.url,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "plp"),
    });
    const pages = [homeCap, cap];

    // Step 1: detect-pagination-mode
    const t1 = Date.now();
    const mode = await withCap(detectPaginationMode(plp, ctx), 15_000, "none" as PaginationMode);
    steps.push({
      step: 1,
      name: "detect-pagination-mode",
      side: ctx.side,
      viewport: ctx.viewport,
      status: "ok",
      durationMs: Date.now() - t1,
      screenshotPath: "",
      detail: { mode },
      actionDescription: `Modo de paginação detectado: ${mode}`,
    });

    if (mode === "none") {
      steps.push({
        step: 2,
        name: "paginate",
        side: ctx.side,
        viewport: ctx.viewport,
        status: "skipped",
        durationMs: 0,
        screenshotPath: "",
        note: "no pagination affordance detected",
      });
      steps.push({
        step: 3,
        name: "verify-pagination",
        side: ctx.side,
        viewport: ctx.viewport,
        status: "skipped",
        durationMs: 0,
        screenshotPath: "",
        note: "nothing to verify — mode=none",
        detail: { mode },
      });
      return { pages, steps };
    }

    // Step 2: paginate
    const t2 = Date.now();
    const beforeLinks = await collectCandidateLinks(plp, selFor(ctx, "productCard"), 24);
    const urlBefore = plp.url();
    if (mode === "page-link") {
      const nextHit = await firstVisibleLocator(plp, selFor(ctx, "paginationNext"));
      if (nextHit) {
        await withCap(
          nextHit.locator.click({ timeout: 3_000 }).catch(() => undefined),
          3_000,
          undefined,
        );
      }
    } else if (mode === "load-more") {
      const loadMoreHit = await firstVisibleLocator(plp, selFor(ctx, "loadMoreButton"));
      if (loadMoreHit) {
        await withCap(
          loadMoreHit.locator.click({ timeout: 3_000 }).catch(() => undefined),
          3_000,
          undefined,
        );
      }
    } else {
      // infinite-scroll
      await scrollPageInChunks(plp);
    }
    await withCap(
      plp.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined),
      8_000,
      undefined,
    );
    await plp.waitForTimeout(500);
    const afterLinks = await collectCandidateLinks(plp, selFor(ctx, "productCard"), 24);
    const urlAfter = plp.url();
    const paginateScreenshot = screenshotPath(ctx, "plp-paginated");
    await screenshotStable(plp, { path: paginateScreenshot });
    steps.push({
      step: 2,
      name: "paginate",
      side: ctx.side,
      viewport: ctx.viewport,
      status: "ok",
      durationMs: Date.now() - t2,
      screenshotPath: paginateScreenshot,
      url: urlAfter,
      beforeUrl: urlBefore,
      detail: { mode, beforeCount: beforeLinks.length, afterCount: afterLinks.length },
      actionDescription: `Ação de paginação (${mode}) executada — ${beforeLinks.length} → ${afterLinks.length} produtos visíveis`,
    });

    // Step 3: verify-pagination
    const t3 = Date.now();
    const beforeHrefs = beforeLinks.map((l) => l.href);
    const afterHrefs = afterLinks.map((l) => l.href);
    const { ok, overlap } = verifyPaginationResult({
      mode,
      before: beforeHrefs,
      after: afterHrefs,
      urlBefore,
      urlAfter,
    });
    steps.push({
      step: 3,
      name: "verify-pagination",
      side: ctx.side,
      viewport: ctx.viewport,
      status: ok ? "ok" : "failed",
      durationMs: Date.now() - t3,
      screenshotPath: paginateScreenshot,
      detail: {
        mode,
        before: beforeHrefs.length,
        after: afterHrefs.length,
        overlap,
        urlBefore,
        urlAfter,
      },
      actionDescription: ok
        ? `Paginação verificada (modo=${mode}, overlap=${overlap.toFixed(2)})`
        : `Paginação falhou na verificação (modo=${mode}, overlap=${overlap.toFixed(2)})`,
    });

    return { pages, steps };
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
