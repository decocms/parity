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

export type StepProgressEvent =
  | { phase: "start"; name: string; index: number; total: number }
  | { phase: "end"; name: string; index: number; total: number; status: StepCapture["status"]; durationMs: number; note?: string };

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
  /** Optional progress callback (each step start/end) */
  onStep?: (event: StepProgressEvent) => void;
}

const PURCHASE_JOURNEY_TOTAL_STEPS = 8;

function selFor(ctx: FlowContext, key: SelectorKey): string[] {
  return selectorsFor(key, { rc: ctx.rc, learned: ctx.learned, platform: ctx.platform });
}

/**
 * Run a named flow. Returns all pages visited and (for purchase-journey) ordered steps.
 */
/**
 * Per-flow hard deadlines so a single misbehaving page can never freeze the
 * whole crawl. `capturePage` already has its own 60s + 10s outer race in
 * `collect.ts`, but a flow can include several page captures plus selector
 * discovery, click + navigation waits, and LLM recovery calls. Real-world
 * runs against CMS-heavy sites have hung for 1h+ at `running flow "plp"`
 * because something inside the flow was waiting on a Playwright op that
 * doesn't honor its declared timeout (most commonly `page.click` followed
 * by an implicit navigation wait when the target page never reaches a
 * settled state).
 *
 * Budget scales with how much each flow has to do — homepage is a single
 * capture, plp/pdp add a navigation step, purchase-journey runs 8 steps.
 * Each individual step has its own timeout caps; this is the safety net
 * for the case where those caps misbehave.
 */
const FLOW_DEADLINE_MS: Record<FlowName, number> = {
  homepage: 90_000, // single capturePage worst case
  plp: 180_000, // home → click category → capturePage
  pdp: 240_000, // home → PLP → click product → capturePage
  "purchase-journey": 360_000, // 8 steps × ~30s + LLM recovery
};

export async function runFlow(flow: FlowName, ctx: FlowContext): Promise<FlowCapture> {
  const start = Date.now();
  const deadlineMs = FLOW_DEADLINE_MS[flow];
  const inner = async (): Promise<FlowCapture> => {
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
  };

  // Run the flow exactly once. If it rejects after the deadline has
  // already won the race (e.g. because we closed its pages), swallow
  // the rejection silently — Promise.race already returned the
  // timeout's FlowCapture and the inner rejection isn't actionable.
  const innerPromise = inner();
  innerPromise.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  // When the deadline fires, the timeout handler initiates page
  // closures and stashes the resulting promise here so the awaiter
  // below can block on them before returning. Defaults to a resolved
  // promise so the inner-wins (success) path is a no-op.
  let cleanup: Promise<unknown> = Promise.resolve();
  const timeoutPromise = new Promise<FlowCapture>((resolve) => {
    timer = setTimeout(() => {
      const pages = ctx.ctx.pages();
      // Seal the timeout result FIRST, synchronously. Closing pages
      // makes any in-flight Playwright op inside `inner()` reject with
      // "Target closed" almost immediately; if we awaited those closes
      // before resolving, Promise.race could pick up the inner
      // rejection first and make runFlow throw instead of returning
      // this timeout FlowCapture. Resolving first guarantees the race
      // is won deterministically by the timeout.
      resolve(
        finalize(
          flow,
          ctx,
          [],
          [
            {
              step: 0,
              name: "visit-home",
              side: ctx.side,
              viewport: ctx.viewport,
              status: "failed",
              durationMs: deadlineMs,
              screenshotPath: "",
              actionDescription: `[flow-timeout] flow "${flow}" excedeu ${deadlineMs}ms — captura abortada pela safety net externa, ${pages.length} page(s) fechada(s) para liberar o contexto. Step interno provavelmente travou em uma operação Playwright que não respeitou seu timeout declarado.`,
            },
          ],
          start,
        ),
      );
      // Now kick off close on every page in the BrowserContext and
      // expose the promise so runFlow can await it before returning.
      // The context stays open — next flow on it calls newPage() and
      // gets a fresh slate. Awaiting here matters because:
      //   - cookies/storage are shared across pages on the same
      //     context, so an in-flight VTEX cart action could finish
      //     between resolve() and the next flow's first interaction.
      //   - newPage() doesn't wait for sibling pages to finish
      //     closing, so without this await the next flow's home
      //     capture could overlap stale network handlers.
      cleanup = Promise.allSettled(pages.map((p) => p.close()));
    }, deadlineMs);
  });

  try {
    const result = await Promise.race([innerPromise, timeoutPromise]);
    // On the timeout path, await the close promises before returning
    // so the caller can start the next flow against a quiesced
    // context. On the success path `cleanup` is the default
    // Promise.resolve() and this is a no-op.
    await cleanup;
    return result;
  } finally {
    // Always clear the deadline timer when the race ends, so we don't
    // leave a pending Node timer keeping the event loop alive until the
    // deadline naturally fires.
    if (timer !== undefined) clearTimeout(timer);
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
  const total = PURCHASE_JOURNEY_TOTAL_STEPS;

  const reportStart = (idx: number, name: string) => {
    ctx.onStep?.({ phase: "start", name, index: idx, total });
  };
  const reportEnd = (
    idx: number,
    name: string,
    status: StepCapture["status"],
    durationMs: number,
    note?: string,
  ) => {
    ctx.onStep?.({ phase: "end", name, index: idx, total, status, durationMs, note });
  };

  try {
    // Step 1: home
    reportStart(1, "visit-home");
    const homeCap = await capturePage(page, {
      url: ctx.baseUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "pj-1-home"),
    });
    pages.push(homeCap);
    const step1Status: StepCapture["status"] = homeCap.status >= 200 && homeCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 1,
      name: "visit-home",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step1Status,
      durationMs: homeCap.durationMs,
      url: homeCap.finalUrl,
      screenshotPath: homeCap.screenshotPath,
    });
    reportEnd(1, "visit-home", step1Status, homeCap.durationMs);
    steps[steps.length - 1]!.actionDescription = `Navegou pra home \`${ctx.baseUrl}\` (HTTP ${homeCap.status})`;
    if (homeCap.status >= 400 || homeCap.status === 0) {
      return { pages, steps };
    }

    // Step 2: navigate to a PLP (with LLM semantic pick)
    reportStart(2, "navigate-plp");
    const plpHit = ctx.rc.plpUrlHint
      ? { url: new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString(), selector: "__hint__" }
      : await findCategoryUrl(page, ctx);
    if (!plpHit) {
      steps.push(makeSkipStep(2, "navigate-plp", ctx, "no category link found"));
      reportEnd(2, "navigate-plp", "skipped", 0, "no category link found");
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
    const step2Status: StepCapture["status"] = plpCap.status >= 200 && plpCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 2,
      name: "navigate-plp",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step2Status,
      durationMs: Date.now() - t2,
      url: plpCap.finalUrl,
      screenshotPath: plpCap.screenshotPath,
      selectorKey: "categoryLink",
      usedSelector: plpHit.selector,
    });
    reportEnd(2, "navigate-plp", step2Status, Date.now() - t2);
    // Annotate step with what we did
    steps[steps.length - 1]!.actionDescription = `Navegou pra categoria \`${plpHit.url}\` (via \`${plpHit.selector}\`)`;
    steps[steps.length - 1]!.beforeUrl = ctx.baseUrl;

    // Step 3: enter PDP
    reportStart(3, "enter-pdp");
    const pdpHit = await findProductUrl(page, ctx);
    if (!pdpHit) {
      steps.push(makeSkipStep(3, "enter-pdp", ctx, "no product card found"));
      reportEnd(3, "enter-pdp", "skipped", 0, "no product card found");
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
    const step3Status: StepCapture["status"] = pdpCap.status >= 200 && pdpCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 3,
      name: "enter-pdp",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step3Status,
      durationMs: Date.now() - t3,
      url: pdpCap.finalUrl,
      screenshotPath: pdpCap.screenshotPath,
      selectorKey: "productCard",
      usedSelector: pdpHit.selector,
    });
    reportEnd(3, "enter-pdp", step3Status, Date.now() - t3);
    steps[steps.length - 1]!.actionDescription = `Abriu PDP \`${pdpHit.url}\` (via \`${pdpHit.selector}\`)`;
    steps[steps.length - 1]!.beforeUrl = plpHit.url;

    // Step 4 (conditional): shipping calc on PDP
    //
    // The default cepInputPdp selectors target the common attribute
    // patterns (`name='zipcode'`, `placeholder*='CEP'`, etc). Sites with
    // a custom CMS markup (label-only, custom name, framework-specific
    // input wrappers) silently miss all of them — the step says "no CEP
    // input on PDP" and skips, when the input is actually visible on
    // screen. Fall through to the same LLM recovery the click steps use
    // before declaring there's no CEP input.
    reportStart(4, "shipping-calc-pdp");
    let cepInputPdp = await firstVisible(page, selFor(ctx, "cepInputPdp"));
    let cepPdpRecovered = false;
    if (!cepInputPdp && recoveryBudget > 0) {
      const recovery = await attemptRecovery(
        page,
        ctx,
        "shipping-calc-pdp",
        "Achar o input de CEP / código postal nesta PDP (deve ser um input visível com label/placeholder relacionado a frete, entrega ou CEP)",
        selFor(ctx, "cepInputPdp"),
      );
      if (recovery) {
        cepInputPdp = recovery.selector;
        cepPdpRecovered = true;
        recoveryBudget--;
      }
    }
    if (cepInputPdp) {
      const t4 = Date.now();
      const beforeUrl4 = page.url();
      const spBefore4 = screenshotPath(ctx, "pj-4-shipping-pdp-before");
      await page.screenshot({ path: spBefore4, fullPage: false }).catch(() => undefined);
      const ok = await fillCep(page, cepInputPdp, ctx.rc.cep);
      const sp = screenshotPath(ctx, "pj-4-shipping-pdp");
      await page.screenshot({ path: sp, fullPage: false }).catch(() => undefined);
      const step4Status: StepCapture["status"] = ok ? "ok" : "failed";
      steps.push({
        step: 4,
        name: "shipping-calc-pdp",
        side: ctx.side,
        viewport: ctx.viewport,
        status: step4Status,
        durationMs: Date.now() - t4,
        url: page.url(),
        screenshotPath: sp,
        screenshotBeforePath: spBefore4,
        beforeUrl: beforeUrl4,
        actionDescription: `Preencheu CEP '${ctx.rc.cep}' no input \`${cepInputPdp}\` e disparou cálculo de frete${cepPdpRecovered ? " (selector via LLM recovery)" : ""}`,
        detail: { cepUsed: ctx.rc.cep },
        selectorKey: "cepInputPdp",
        usedSelector: cepInputPdp,
        recoveredByLlm: cepPdpRecovered || undefined,
      });
      reportEnd(4, "shipping-calc-pdp", step4Status, Date.now() - t4);
    } else {
      steps.push(makeSkipStep(4, "shipping-calc-pdp", ctx, "no CEP input on PDP (recovery exhausted)"));
      reportEnd(4, "shipping-calc-pdp", "skipped", 0, "no CEP input on PDP");
    }

    // Step 5: add to cart (with LLM recovery)
    reportStart(5, "add-to-cart");
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
      reportEnd(5, "add-to-cart", "skipped", 0, "no buy button found");
      return { pages, steps };
    }
    const t5 = Date.now();
    const beforeUrl5 = page.url();
    const spBefore5 = screenshotPath(ctx, "pj-5-add-cart-before");
    await page.screenshot({ path: spBefore5, fullPage: false }).catch(() => undefined);
    const buyText = await buyHit.locator.innerText().catch(() => "");
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
      url: page.url(),
      screenshotPath: sp5,
      screenshotBeforePath: spBefore5,
      beforeUrl: beforeUrl5,
      actionDescription: `Clicou no botão${buyText ? ` '${buyText.slice(0, 40).trim()}'` : ""} (\`${buyHit.selector}\`)${buyRecovered ? " — selector veio de recovery LLM" : ""}`,
      selectorKey: "buyButton",
      usedSelector: buyHit.selector,
      recoveredByLlm: buyRecovered || undefined,
    });
    reportEnd(5, "add-to-cart", "ok", Date.now() - t5);

    // Step 6: open minicart
    reportStart(6, "open-minicart");
    const t6 = Date.now();
    const beforeUrl6 = page.url();
    const spBefore6 = screenshotPath(ctx, "pj-6-minicart-before");
    await page.screenshot({ path: spBefore6, fullPage: false }).catch(() => undefined);
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
    let miniText = "";
    if (miniHit) {
      miniText = await miniHit.locator.innerText().catch(() => "");
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
      url: page.url(),
      screenshotPath: sp6,
      screenshotBeforePath: spBefore6,
      beforeUrl: beforeUrl6,
      actionDescription: miniHit
        ? `Clicou no trigger do minicart${miniText ? ` '${miniText.slice(0, 30).trim()}'` : ""} (\`${miniHit.selector}\`)${miniRecovered ? " — selector via recovery LLM" : ""}`
        : "Minicart já aberto após add-to-cart (drawer/popup)",
      selectorKey: miniHit ? "minicartTrigger" : undefined,
      usedSelector: miniHit?.selector,
      recoveredByLlm: miniRecovered || undefined,
    });
    reportEnd(6, "open-minicart", "ok", Date.now() - t6);

    // Step 7: shipping calc in cart
    reportStart(7, "shipping-calc-cart");
    let cepInputCart = await firstVisible(page, selFor(ctx, "cepInputCart"));
    let cepCartRecovered = false;
    if (!cepInputCart && recoveryBudget > 0) {
      const recovery = await attemptRecovery(
        page,
        ctx,
        "shipping-calc-cart",
        "Achar o input de CEP / código postal dentro do carrinho ou minicart aberto agora (input visível com label/placeholder de frete, entrega ou CEP)",
        selFor(ctx, "cepInputCart"),
      );
      if (recovery) {
        cepInputCart = recovery.selector;
        cepCartRecovered = true;
        recoveryBudget--;
      }
    }
    if (cepInputCart) {
      const t7 = Date.now();
      const beforeUrl7 = page.url();
      const spBefore7 = screenshotPath(ctx, "pj-7-shipping-cart-before");
      await page.screenshot({ path: spBefore7, fullPage: false }).catch(() => undefined);
      const ok = await fillCep(page, cepInputCart, ctx.rc.cep);
      const sp7 = screenshotPath(ctx, "pj-7-shipping-cart");
      await page.screenshot({ path: sp7, fullPage: false }).catch(() => undefined);
      const step7Status: StepCapture["status"] = ok ? "ok" : "failed";
      steps.push({
        step: 7,
        name: "shipping-calc-cart",
        side: ctx.side,
        viewport: ctx.viewport,
        status: step7Status,
        durationMs: Date.now() - t7,
        url: page.url(),
        screenshotPath: sp7,
        screenshotBeforePath: spBefore7,
        beforeUrl: beforeUrl7,
        actionDescription: `Preencheu CEP '${ctx.rc.cep}' no carrinho (\`${cepInputCart}\`)${cepCartRecovered ? " (selector via LLM recovery)" : ""}`,
        detail: { cepUsed: ctx.rc.cep },
        selectorKey: "cepInputCart",
        usedSelector: cepInputCart,
        recoveredByLlm: cepCartRecovered || undefined,
      });
      reportEnd(7, "shipping-calc-cart", step7Status, Date.now() - t7);
    } else {
      steps.push(makeSkipStep(7, "shipping-calc-cart", ctx, "no CEP input in cart (recovery exhausted)"));
      reportEnd(7, "shipping-calc-cart", "skipped", 0, "no CEP input in cart");
    }

    // Step 8: go to checkout
    //
    // The default selectors hard-code variants of "Finalizar compra" /
    // "Ir para o checkout" / "Checkout" / `[data-checkout-button]`. Sites
    // with non-standard cart CTAs (e.g. miess uses just "Finalizar")
    // either don't match any default OR match a wrong element that
    // happens to satisfy the selector but doesn't navigate to /checkout.
    //
    // The single-shot click + URL check below catches the second case
    // (wrong element matched, URL stays on cart). When that happens we
    // now retry with an LLM recovery call that sees the current cart
    // HTML — that's the context the up-front discovery phase never had.
    reportStart(8, "go-checkout");
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
      reportEnd(8, "go-checkout", "skipped", 0, "no checkout button found");
      return { pages, steps };
    }

    /**
     * One attempt at the checkout flow:
     *   1. Take a "before" screenshot.
     *   2. Race the click against `waitForURL(/checkout/)` so the click+nav
     *      finish together when the button is correct.
     *   3. Settle, take an "after" screenshot, check the final URL.
     *
     * Returns the screenshot paths + final URL + text the button had, so
     * the caller can decide whether to retry with a different selector
     * (LLM-discovered) when the URL didn't actually reach checkout.
     */
    const tryCheckoutClick = async (
      hit: NonNullable<typeof checkoutHit>,
      attempt: number,
    ): Promise<{ url: string; spBefore: string; spAfter: string; clickedText: string }> => {
      const spBefore = screenshotPath(ctx, `pj-8-checkout-before-${attempt}`);
      await page.screenshot({ path: spBefore, fullPage: false }).catch(() => undefined);
      const clickedText = await hit.locator.innerText().catch(() => "");
      await Promise.all([
        page.waitForURL(/checkout/i, { timeout: 10_000 }).catch(() => undefined),
        hit.locator.click({ timeout: 5_000 }).catch(() => undefined),
      ]);
      await page.waitForTimeout(1_500);
      const spAfter = screenshotPath(ctx, `pj-8-checkout-reached-${attempt}`);
      await page.screenshot({ path: spAfter, fullPage: false }).catch(() => undefined);
      return { url: page.url(), spBefore, spAfter, clickedText };
    };

    const t8 = Date.now();
    const beforeUrl8 = page.url();
    let attempt = 1;
    let result = await tryCheckoutClick(checkoutHit, attempt);
    let reachedCheckout = /\/checkout/i.test(result.url);
    let usedSelector = checkoutHit.selector;
    let clickedText = result.clickedText;

    // If we clicked something but the URL didn't change to /checkout, the
    // selector likely picked a button that ISN'T the real checkout CTA.
    // Burn one recovery slot on a fresh LLM call that sees the cart HTML
    // as it stands NOW (post-failed-click) and ask for the actual
    // navigation trigger. This is the "LLM should see the rendered cart,
    // not just the home" path the discovery phase can't take on its own.
    if (!reachedCheckout && recoveryBudget > 0 && !/\/checkout/i.test(beforeUrl8)) {
      const retrySuggestion = await attemptRecovery(
        page,
        ctx,
        "go-checkout-retry",
        `Cliquei em '${clickedText.slice(0, 40).trim()}' (selector \`${usedSelector}\`), mas a URL ficou em ${result.url} e não foi pra /checkout. Achar o botão que de fato navega pra /checkout neste cart/minicart aberto.`,
        [usedSelector, ...selFor(ctx, "checkoutButton")],
      );
      if (retrySuggestion) {
        recoveryBudget--;
        checkoutRecovered = true;
        attempt++;
        const retryResult = await tryCheckoutClick(retrySuggestion, attempt);
        // Always promote the retry to the "current" attempt — it IS the
        // most recent action, so the reported URL, screenshot paths,
        // selector and clicked text must reflect it. Whether the retry
        // *succeeded* is decided by URL match alone.
        result = retryResult;
        usedSelector = retrySuggestion.selector;
        clickedText = retryResult.clickedText;
        reachedCheckout = /\/checkout/i.test(retryResult.url);
      }
    }

    const step8Status: StepCapture["status"] = reachedCheckout ? "ok" : "failed";
    steps.push({
      step: 8,
      name: "go-checkout",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step8Status,
      durationMs: Date.now() - t8,
      url: result.url,
      screenshotPath: result.spAfter,
      screenshotBeforePath: result.spBefore,
      beforeUrl: beforeUrl8,
      actionDescription: `Clicou em${clickedText ? ` '${clickedText.slice(0, 30).trim()}'` : ""} (\`${usedSelector}\`); URL final: ${result.url}${reachedCheckout ? " ✓ atingiu /checkout" : " ✗ não foi pra checkout"}${attempt > 1 ? ` (após ${attempt} tentativas com recovery LLM)` : ""}`,
      selectorKey: "checkoutButton",
      usedSelector,
      recoveredByLlm: checkoutRecovered || undefined,
    });
    reportEnd(8, "go-checkout", step8Status, Date.now() - t8);

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
