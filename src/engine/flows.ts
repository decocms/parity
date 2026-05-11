import type { BrowserContext, Locator, Page } from "playwright";
import type { LearnedSelectors } from "../learned/repo.ts";
import type { Platform } from "../learned/platform.ts";
import { pickCategoryLink } from "../llm/pick-plp.ts";
import { suggestRecovery } from "../llm/recover-step.ts";
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
  /** Optional learned selectors library (cascade integration) */
  learned?: LearnedSelectors;
  /** Optional detected platform for the prod side */
  platform?: Platform;
  /** Max LLM-driven step recoveries per flow */
  recoveryBudget?: number;
}

function selFor(ctx: FlowContext, key: SelectorKey): string[] {
  return selectorsFor(key, { rc: ctx.rc, learned: ctx.learned, platform: ctx.platform });
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

interface PurchaseJourneyResult {
  pages: PageCapture[];
  steps: StepCapture[];
}

async function flowPurchaseJourney(ctx: FlowContext): Promise<PurchaseJourneyResult> {
  const pages: PageCapture[] = [];
  const steps: StepCapture[] = [];
  const page = await ctx.ctx.newPage();
  let recoveryBudget = ctx.recoveryBudget ?? 3;

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

    // Step 2: navigate to a PLP (with LLM semantic pick)
    const plpHit = ctx.rc.plpUrlHint
      ? { url: new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString(), selector: "__hint__" }
      : await findCategoryUrl(page, ctx);
    if (!plpHit) {
      steps.push(makeSkipStep(2, "navigate-plp", ctx, "no category link found"));
      return { pages, steps };
    }
    const t2 = Date.now();
    const plpCap = await capturePage(page, {
      url: plpHit.url,
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
      selectorKey: "categoryLink",
      usedSelector: plpHit.selector,
    });

    // Step 3: enter PDP
    const pdpHit = await findProductUrl(page, ctx);
    if (!pdpHit) {
      steps.push(makeSkipStep(3, "enter-pdp", ctx, "no product card found"));
      return { pages, steps };
    }
    const t3 = Date.now();
    const pdpCap = await capturePage(page, {
      url: pdpHit.url,
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
      selectorKey: "productCard",
      usedSelector: pdpHit.selector,
    });

    // Step 4 (conditional): shipping calc on PDP
    const cepInputPdp = await firstVisible(page, selFor(ctx, "cepInputPdp"));
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
        selectorKey: "cepInputPdp",
        usedSelector: cepInputPdp,
      });
    } else {
      steps.push(makeSkipStep(4, "shipping-calc-pdp", ctx, "no CEP input on PDP"));
    }

    // Step 5: add to cart (with LLM recovery)
    let buyHit = await firstVisibleLocator(page, selFor(ctx, "buyButton"));
    let buyRecovered = false;
    if (!buyHit && recoveryBudget > 0) {
      const recovery = await attemptRecovery(page, ctx, "add-to-cart", "Clicar no botão de comprar/adicionar ao carrinho", selFor(ctx, "buyButton"));
      if (recovery) {
        buyHit = recovery;
        buyRecovered = true;
        recoveryBudget--;
      }
    }
    if (!buyHit) {
      steps.push(makeSkipStep(5, "add-to-cart", ctx, "no buy button found (recovery exhausted)"));
      return { pages, steps };
    }
    const t5 = Date.now();
    await buyHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
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
      selectorKey: "buyButton",
      usedSelector: buyHit.selector,
      recoveredByLlm: buyRecovered || undefined,
    });

    // Step 6: open minicart
    const t6 = Date.now();
    let miniHit = await firstVisibleLocator(page, selFor(ctx, "minicartTrigger"));
    let miniRecovered = false;
    if (!miniHit && recoveryBudget > 0) {
      const recovery = await attemptRecovery(page, ctx, "open-minicart", "Abrir o minicart/drawer do carrinho", selFor(ctx, "minicartTrigger"));
      if (recovery) {
        miniHit = recovery;
        miniRecovered = true;
        recoveryBudget--;
      }
    }
    if (miniHit) {
      await miniHit.locator.click({ timeout: 3_000 }).catch(() => undefined);
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
      selectorKey: miniHit ? "minicartTrigger" : undefined,
      usedSelector: miniHit?.selector,
      recoveredByLlm: miniRecovered || undefined,
    });

    // Step 7: shipping calc in cart
    const cepInputCart = await firstVisible(page, selFor(ctx, "cepInputCart"));
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
        selectorKey: "cepInputCart",
        usedSelector: cepInputCart,
      });
    } else {
      steps.push(makeSkipStep(7, "shipping-calc-cart", ctx, "no CEP input in cart"));
    }

    // Step 8: go to checkout
    let checkoutHit = await firstVisibleLocator(page, selFor(ctx, "checkoutButton"));
    let checkoutRecovered = false;
    if (!checkoutHit && recoveryBudget > 0) {
      const recovery = await attemptRecovery(page, ctx, "go-checkout", "Clicar no botão 'Finalizar compra' / 'Ir para o checkout'", selFor(ctx, "checkoutButton"));
      if (recovery) {
        checkoutHit = recovery;
        checkoutRecovered = true;
        recoveryBudget--;
      }
    }
    if (!checkoutHit) {
      steps.push(makeSkipStep(8, "go-checkout", ctx, "no checkout button found (recovery exhausted)"));
      return { pages, steps };
    }
    const t8 = Date.now();
    await Promise.all([
      page.waitForURL(/checkout/i, { timeout: 10_000 }).catch(() => undefined),
      checkoutHit.locator.click({ timeout: 5_000 }).catch(() => undefined),
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
      selectorKey: "checkoutButton",
      usedSelector: checkoutHit.selector,
      recoveredByLlm: checkoutRecovered || undefined,
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

async function findCategoryUrl(
  page: Page,
  ctx: FlowContext,
): Promise<{ url: string; selector: string } | null> {
  const selectors = selFor(ctx, "categoryLink");
  const candidates = await collectCandidateLinks(page, selectors, 12);
  if (candidates.length === 0) return null;
  const picked = await pickCategoryLink(candidates.map((c) => ({ text: c.text, href: c.href })));
  if (!picked) return null;
  const original = candidates.find((c) => c.href === picked.href);
  return original ? { url: original.href, selector: original.selector } : null;
}

async function findProductUrl(
  page: Page,
  ctx: FlowContext,
): Promise<{ url: string; selector: string } | null> {
  return await firstVisibleHref(page, selFor(ctx, "productCard"));
}

async function firstVisibleHref(
  page: Page,
  selectors: string[],
): Promise<{ url: string; selector: string } | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
        const href = await el.getAttribute("href");
        if (href) {
          try {
            return { url: new URL(href, page.url()).toString(), selector: sel };
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

async function firstVisibleLocator(
  page: Page,
  selectors: string[],
): Promise<{ locator: Locator; selector: string } | null> {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1_000 }).catch(() => false)) {
        return { locator: el, selector: sel };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function collectCandidateLinks(
  page: Page,
  selectors: string[],
  limit = 12,
): Promise<{ text: string; href: string; selector: string }[]> {
  const out: { text: string; href: string; selector: string }[] = [];
  const seenHrefs = new Set<string>();
  for (const sel of selectors) {
    if (out.length >= limit) break;
    try {
      const elements = page.locator(sel);
      const count = await elements.count();
      for (let i = 0; i < count && out.length < limit; i++) {
        const el = elements.nth(i);
        if (!(await el.isVisible({ timeout: 250 }).catch(() => false))) continue;
        const href = await el.getAttribute("href").catch(() => null);
        if (!href) continue;
        let abs = href;
        try {
          abs = new URL(href, page.url()).toString();
        } catch {
          continue;
        }
        if (seenHrefs.has(abs)) continue;
        seenHrefs.add(abs);
        const text = (await el.innerText().catch(() => "")).slice(0, 60).trim();
        out.push({ text, href: abs, selector: sel });
      }
    } catch {
      /* try next */
    }
  }
  return out;
}

async function fillCep(page: Page, selector: string, cep: string): Promise<boolean> {
  try {
    await page.locator(selector).first().fill(cep, { timeout: 3_000 });
    await page.locator(selector).first().press("Enter").catch(() => undefined);
    await page.waitForTimeout(3_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the LLM to recover from a failed selector lookup. Returns a usable
 * locator + the suggested selector string, or null if the recovery failed.
 */
async function attemptRecovery(
  page: Page,
  _ctx: FlowContext,
  stepName: string,
  intendedAction: string,
  alreadyTried: string[],
): Promise<{ locator: Locator; selector: string } | null> {
  let html = "";
  try {
    html = await page.content();
  } catch {
    return null;
  }
  const suggestion = await suggestRecovery({ stepName, intendedAction, html, alreadyTried });
  if (!suggestion) return null;
  try {
    const el = page.locator(suggestion.selector).first();
    if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
      return { locator: el, selector: suggestion.selector };
    }
  } catch {
    /* selector invalid or not found */
  }
  return null;
}
