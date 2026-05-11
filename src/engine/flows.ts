import type { BrowserContext, Page } from "playwright";
import type {
  FlowCapture,
  FlowName,
  PageCapture,
  ParityRc,
  Side,
  StepCapture,
  Viewport,
} from "../types/schema.ts";
import { capturePage } from "./collect.ts";
import { selectorsFor } from "./selectors.ts";
import type { SelectorKey } from "./selectors.ts";

export interface FlowContext {
  baseUrl: string;
  side: Side;
  viewport: Viewport;
  rc: ParityRc;
  ctx: BrowserContext;
  /** Output dir for screenshots/HARs of this flow */
  outDir: string;
}

/**
 * Run a named flow. Returns all pages visited and (for purchase-journey) ordered steps.
 */
export async function runFlow(flow: FlowName, ctx: FlowContext): Promise<FlowCapture> {
  const start = Date.now();
  switch (flow) {
    case "homepage":
      return finalize(flow, ctx, await flowHomepage(ctx), [], start);
    case "plp":
      return finalize(flow, ctx, await flowPlp(ctx), [], start);
    case "pdp":
      return finalize(flow, ctx, await flowPdp(ctx), [], start);
    case "purchase-journey": {
      const { pages, steps } = await flowPurchaseJourney(ctx);
      return finalize(flow, ctx, pages, steps, start);
    }
  }
}

function finalize(
  flow: FlowName,
  ctx: FlowContext,
  pages: PageCapture[],
  steps: StepCapture[],
  start: number,
): FlowCapture {
  return {
    flow,
    side: ctx.side,
    viewport: ctx.viewport,
    pages,
    steps,
    totalDurationMs: Date.now() - start,
  };
}

function screenshotPath(ctx: FlowContext, label: string): string {
  const safe = label.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  return `${ctx.outDir}/${safe}-${ctx.viewport}-${ctx.side}.png`;
}

async function flowHomepage(ctx: FlowContext): Promise<PageCapture[]> {
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

async function flowPlp(ctx: FlowContext): Promise<PageCapture[]> {
  const home = await ctx.ctx.newPage();
  const homeCap = await capturePage(home, {
    url: ctx.baseUrl,
    side: ctx.side,
    viewport: ctx.viewport,
    screenshotPath: screenshotPath(ctx, "home"),
  });
  const plpUrl = ctx.rc.plpUrlHint
    ? new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString()
    : await findCategoryUrl(home, ctx.rc);
  await home.close();

  if (!plpUrl) return [homeCap];

  const plp = await ctx.ctx.newPage();
  try {
    const cap = await capturePage(plp, {
      url: plpUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "plp"),
    });
    return [homeCap, cap];
  } finally {
    await plp.close();
  }
}

async function flowPdp(ctx: FlowContext): Promise<PageCapture[]> {
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
  const plpUrl = ctx.rc.plpUrlHint
    ? new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString()
    : await findCategoryUrl(home, ctx.rc);
  await home.close();
  if (!plpUrl) return pages;

  const plp = await ctx.ctx.newPage();
  pages.push(
    await capturePage(plp, {
      url: plpUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "plp"),
    }),
  );
  const pdpUrl = await findProductUrl(plp, ctx.rc);
  await plp.close();
  if (!pdpUrl) return pages;

  const pdp = await ctx.ctx.newPage();
  try {
    pages.push(
      await capturePage(pdp, {
        url: pdpUrl,
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

interface PurchaseJourneyResult {
  pages: PageCapture[];
  steps: StepCapture[];
}

async function flowPurchaseJourney(ctx: FlowContext): Promise<PurchaseJourneyResult> {
  const pages: PageCapture[] = [];
  const steps: StepCapture[] = [];
  const page = await ctx.ctx.newPage();

  try {
    // Step 1: home
    const homeCap = await capturePage(page, {
      url: ctx.baseUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "pj-1-home"),
    });
    pages.push(homeCap);
    steps.push({
      step: 1,
      name: "visit-home",
      side: ctx.side,
      viewport: ctx.viewport,
      status: homeCap.status >= 200 && homeCap.status < 400 ? "ok" : "failed",
      durationMs: homeCap.durationMs,
      url: homeCap.finalUrl,
      screenshotPath: homeCap.screenshotPath,
    });
    if (homeCap.status >= 400 || homeCap.status === 0) {
      return { pages, steps };
    }

    // Step 2: navigate to a PLP
    const plpUrl = ctx.rc.plpUrlHint
      ? new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString()
      : await findCategoryUrl(page, ctx.rc);
    if (!plpUrl) {
      steps.push(makeSkipStep(2, "navigate-plp", ctx, "no category link found"));
      return { pages, steps };
    }
    const t2 = Date.now();
    const plpCap = await capturePage(page, {
      url: plpUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "pj-2-plp"),
    });
    pages.push(plpCap);
    steps.push({
      step: 2,
      name: "navigate-plp",
      side: ctx.side,
      viewport: ctx.viewport,
      status: plpCap.status >= 200 && plpCap.status < 400 ? "ok" : "failed",
      durationMs: Date.now() - t2,
      url: plpCap.finalUrl,
      screenshotPath: plpCap.screenshotPath,
    });

    // Step 3: enter PDP
    const pdpUrl = await findProductUrl(page, ctx.rc);
    if (!pdpUrl) {
      steps.push(makeSkipStep(3, "enter-pdp", ctx, "no product card found"));
      return { pages, steps };
    }
    const t3 = Date.now();
    const pdpCap = await capturePage(page, {
      url: pdpUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "pj-3-pdp"),
    });
    pages.push(pdpCap);
    steps.push({
      step: 3,
      name: "enter-pdp",
      side: ctx.side,
      viewport: ctx.viewport,
      status: pdpCap.status >= 200 && pdpCap.status < 400 ? "ok" : "failed",
      durationMs: Date.now() - t3,
      url: pdpCap.finalUrl,
      screenshotPath: pdpCap.screenshotPath,
    });

    // Step 4 (conditional): shipping calc on PDP
    const cepInputPdp = await firstVisible(page, selectorsFor("cepInputPdp", ctx.rc));
    if (cepInputPdp) {
      const t4 = Date.now();
      const ok = await fillCep(page, cepInputPdp, ctx.rc.cep);
      const sp = screenshotPath(ctx, "pj-4-shipping-pdp");
      await page.screenshot({ path: sp, fullPage: false }).catch(() => undefined);
      steps.push({
        step: 4,
        name: "shipping-calc-pdp",
        side: ctx.side,
        viewport: ctx.viewport,
        status: ok ? "ok" : "failed",
        durationMs: Date.now() - t4,
        screenshotPath: sp,
        detail: { cepUsed: ctx.rc.cep },
      });
    } else {
      steps.push(makeSkipStep(4, "shipping-calc-pdp", ctx, "no CEP input on PDP"));
    }

    // Step 5: add to cart
    const buyLocator = await firstVisibleLocator(page, selectorsFor("buyButton", ctx.rc));
    if (!buyLocator) {
      steps.push(makeSkipStep(5, "add-to-cart", ctx, "no buy button found"));
      return { pages, steps };
    }
    const t5 = Date.now();
    await buyLocator.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const sp5 = screenshotPath(ctx, "pj-5-add-cart");
    await page.screenshot({ path: sp5, fullPage: false }).catch(() => undefined);
    steps.push({
      step: 5,
      name: "add-to-cart",
      side: ctx.side,
      viewport: ctx.viewport,
      status: "ok",
      durationMs: Date.now() - t5,
      screenshotPath: sp5,
    });

    // Step 6: open minicart (may already be open after add-to-cart)
    const t6 = Date.now();
    const miniTrigger = await firstVisibleLocator(page, selectorsFor("minicartTrigger", ctx.rc));
    if (miniTrigger) {
      await miniTrigger.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
    }
    const sp6 = screenshotPath(ctx, "pj-6-minicart");
    await page.screenshot({ path: sp6, fullPage: false }).catch(() => undefined);
    steps.push({
      step: 6,
      name: "open-minicart",
      side: ctx.side,
      viewport: ctx.viewport,
      status: "ok",
      durationMs: Date.now() - t6,
      screenshotPath: sp6,
    });

    // Step 7: shipping calc in cart
    const cepInputCart = await firstVisible(page, selectorsFor("cepInputCart", ctx.rc));
    if (cepInputCart) {
      const t7 = Date.now();
      const ok = await fillCep(page, cepInputCart, ctx.rc.cep);
      const sp7 = screenshotPath(ctx, "pj-7-shipping-cart");
      await page.screenshot({ path: sp7, fullPage: false }).catch(() => undefined);
      steps.push({
        step: 7,
        name: "shipping-calc-cart",
        side: ctx.side,
        viewport: ctx.viewport,
        status: ok ? "ok" : "failed",
        durationMs: Date.now() - t7,
        screenshotPath: sp7,
        detail: { cepUsed: ctx.rc.cep },
      });
    } else {
      steps.push(makeSkipStep(7, "shipping-calc-cart", ctx, "no CEP input in cart"));
    }

    // Step 8: go to checkout
    const checkoutBtn = await firstVisibleLocator(page, selectorsFor("checkoutButton", ctx.rc));
    if (!checkoutBtn) {
      steps.push(makeSkipStep(8, "go-checkout", ctx, "no checkout button found"));
      return { pages, steps };
    }
    const t8 = Date.now();
    await Promise.all([
      page.waitForURL(/checkout/i, { timeout: 10_000 }).catch(() => undefined),
      checkoutBtn.click({ timeout: 5_000 }).catch(() => undefined),
    ]);
    await page.waitForTimeout(1_500);
    const sp8 = screenshotPath(ctx, "pj-8-checkout-reached");
    await page.screenshot({ path: sp8, fullPage: false }).catch(() => undefined);
    const checkoutUrl = page.url();
    const reachedCheckout = /\/checkout/i.test(checkoutUrl);
    steps.push({
      step: 8,
      name: "go-checkout",
      side: ctx.side,
      viewport: ctx.viewport,
      status: reachedCheckout ? "ok" : "failed",
      durationMs: Date.now() - t8,
      url: checkoutUrl,
      screenshotPath: sp8,
    });

    return { pages, steps };
  } finally {
    await page.close();
  }
}

function makeSkipStep(
  step: number,
  name: string,
  ctx: FlowContext,
  note: string,
): StepCapture {
  return {
    step,
    name,
    side: ctx.side,
    viewport: ctx.viewport,
    status: "skipped",
    durationMs: 0,
    screenshotPath: "",
    note,
  };
}

async function findCategoryUrl(page: Page, rc: ParityRc): Promise<string | null> {
  return await firstVisibleHref(page, selectorsFor("categoryLink", rc));
}

async function findProductUrl(page: Page, rc: ParityRc): Promise<string | null> {
  return await firstVisibleHref(page, selectorsFor("productCard", rc));
}

async function firstVisibleHref(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
        const href = await el.getAttribute("href");
        if (href) {
          try {
            return new URL(href, page.url()).toString();
          } catch {
            return null;
          }
        }
      }
    } catch {
      /* try next selector */
    }
  }
  return null;
}

async function firstVisible(page: Page, selectors: string[]): Promise<string | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return sel;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function firstVisibleLocator(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return el;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function fillCep(page: Page, selector: string, cep: string): Promise<boolean> {
  try {
    await page.locator(selector).first().fill(cep, { timeout: 3_000 });
    // submit: try Enter then surrounding button
    await page.locator(selector).first().press("Enter").catch(() => undefined);
    // wait for any shipping response
    await page.waitForTimeout(3_000);
    return true;
  } catch {
    return false;
  }
}
