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

const DEBUG_PARITY = process.env.DEBUG_PARITY === "1" || process.env.DEBUG_PARITY === "true";
const DEBUG_START = Date.now();
function dlog(ctx: FlowContext, msg: string): void {
  if (!DEBUG_PARITY) return;
  const elapsed = ((Date.now() - DEBUG_START) / 1000).toFixed(1);
  process.stderr.write(`[+${elapsed}s ${ctx.viewport}/${ctx.side}] ${msg}\n`);
}

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
              name: "flow-timeout",
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
      //
      // `page.close()` can hang on a wedged page (V8 main thread
      // stuck in a tight loop = beforeunload handler never runs).
      // Cap each close at 5s so the cleanup awaitable can always
      // resolve and the next flow gets to start.
      const CLOSE_CAP_MS = 5_000;
      const cappedClose = (p: (typeof pages)[number]): Promise<void> =>
        Promise.race([
          p.close().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, CLOSE_CAP_MS)),
        ]);
      cleanup = Promise.allSettled(pages.map(cappedClose));
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
    //
    // For purchase-journey we don't need a full-page visual asset — what
    // we need is interactive elements (header nav, buy buttons, minicart
    // trigger) to be findable. The full scrollFullPage at the end of
    // capturePage rolls the viewport to the bottom of the page, which
    // on mobile commonly hides sticky headers behind the auto-hide
    // header behavior. By the time we run findCategoryUrl the header
    // nav is no longer visible and `isVisible()` returns false for every
    // category link. Skipping the scroll keeps the viewport at top and
    // the nav reachable. Screenshots in journey mode are only for
    // evidence/debugging anyway, not visual-diff.
    reportStart(1, "visit-home");
    dlog(ctx, `step 1 visit-home: capturePage(${ctx.baseUrl}) start (scrollToLoad=false)`);
    const homeCap = await capturePage(page, {
      url: ctx.baseUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "pj-1-home"),
      scrollToLoad: false,
    });
    dlog(ctx, `step 1 visit-home: capturePage done status=${homeCap.status}`);
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
    dlog(ctx, `step 2 navigate-plp: findCategoryUrl start (hint=${ctx.rc.plpUrlHint ?? "—"})`);
    const plpHit = ctx.rc.plpUrlHint
      ? { url: new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString(), selector: "__hint__" }
      : await findCategoryUrl(page, ctx);
    dlog(ctx, `step 2 navigate-plp: findCategoryUrl done → ${plpHit?.url ?? "null"}`);
    if (!plpHit) {
      steps.push(makeSkipStep(2, "navigate-plp", ctx, "no category link found"));
      reportEnd(2, "navigate-plp", "skipped", 0, "no category link found");
      return { pages, steps };
    }
    const t2 = Date.now();
    dlog(ctx, `step 2 navigate-plp: capturePage(${plpHit.url}) start (scrollToLoad=false)`);
    const plpCap = await capturePage(page, {
      url: plpHit.url,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "pj-2-plp"),
      scrollToLoad: false,
    });
    dlog(ctx, `step 2 navigate-plp: capturePage done status=${plpCap.status}`);
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
      scrollToLoad: false,
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

    // Pull the product title now while we're on the PDP — used later
    // (steps 6 and 8) to validate the same product appears in the cart
    // drawer and on the checkout page. If we can't extract a title,
    // cart validation is skipped (recorded in step.cartValidation).
    const expectedProductTitle = await extractProductTitle(page);
    dlog(ctx, `step 3 enter-pdp: extracted product title → ${expectedProductTitle ? `"${expectedProductTitle.slice(0, 60)}"` : "null"}`);
    if (expectedProductTitle) {
      steps[steps.length - 1]!.detail = {
        ...(steps[steps.length - 1]!.detail ?? {}),
        productTitle: expectedProductTitle,
      };
    }

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
    //
    // Three real-world patterns observed:
    //   (a) click on cart icon → drawer overlay slides in (most sites)
    //   (b) click on cart icon → navigates to /cart or /checkout (miess
    //       mobile prod, simple Wake stores)
    //   (c) hover on cart icon → minicart popup (miess desktop prod,
    //       desktop VTEX with the mega-menu cart hover)
    //
    // `openMinicart` handles all three, falling back to hover when
    // click doesn't reveal anything. After the cart UI is visible we
    // validate that the product added in step 5 is actually listed —
    // this is what makes the journey a real e2e check instead of just
    // "did clicks succeed".
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
    let cartOpenMethod: NonNullable<StepCapture["cartOpenMethod"]> = "failed";
    let miniText = "";
    if (miniHit) {
      miniText = await miniHit.locator.innerText().catch(() => "");
      const openResult = await openMinicart(page, miniHit, ctx, expectedProductTitle);
      cartOpenMethod = openResult.method;
    } else {
      // No trigger needed — the drawer may already be open from step 5
      // (some sites auto-open the minicart after add-to-cart).
      const alreadyOpen = await isCartRevealed(page, expectedProductTitle);
      if (alreadyOpen) {
        cartOpenMethod = "already-open";
        dlog(ctx, `step 6 open-minicart: no trigger, but drawer already visible (matched ${alreadyOpen})`);
      }
    }
    // Validate that the product added in step 5 is now visible in the
    // cart UI. Only runs when we successfully revealed the cart and
    // captured the product title back in step 3.
    let step6Validation: StepCapture["cartValidation"];
    if (expectedProductTitle && cartOpenMethod !== "failed") {
      const v = await validateCartContainsTitle(page, expectedProductTitle, ctx);
      let reasonText: string | undefined;
      if (!v.found) {
        if (v.observedTitles.length === 0) {
          const emptyBanner = await detectEmptyCartBanner(page);
          reasonText = emptyBanner
            ? `cart genuinely empty — upstream add-to-cart didn't persist (session/cookie may not have carried over). Banner observed: "${emptyBanner}"`
            : "no cart line items visible after open (selectors may not match markup)";
        } else {
          reasonText = `expected title not found among ${v.observedTitles.length} observed`;
        }
      }
      step6Validation = {
        expectedTitle: expectedProductTitle,
        found: v.found,
        method: v.method,
        observedTitles: v.observedTitles.slice(0, 8),
        reason: reasonText,
      };
      dlog(ctx, `step 6 open-minicart: cart validation → found=${v.found} (${v.method})${reasonText ? ` — ${reasonText.slice(0, 80)}` : ""}`);
    } else if (!expectedProductTitle) {
      dlog(ctx, "step 6 open-minicart: skipping validation — no PDP title captured");
    } else {
      dlog(ctx, "step 6 open-minicart: skipping validation — cart UI not revealed");
    }
    const sp6 = screenshotPath(ctx, "pj-6-minicart");
    await page.screenshot({ path: sp6, fullPage: false }).catch(() => undefined);
    const step6Status: StepCapture["status"] =
      cartOpenMethod === "failed" ? "failed" : step6Validation && !step6Validation.found ? "failed" : "ok";
    steps.push({
      step: 6,
      name: "open-minicart",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step6Status,
      durationMs: Date.now() - t6,
      url: page.url(),
      screenshotPath: sp6,
      screenshotBeforePath: spBefore6,
      beforeUrl: beforeUrl6,
      cartOpenMethod,
      cartValidation: step6Validation,
      actionDescription: miniHit
        ? `Abriu minicart via ${cartOpenMethod}${miniText ? ` em '${miniText.slice(0, 30).trim()}'` : ""} (\`${miniHit.selector}\`)${miniRecovered ? " — selector via recovery LLM" : ""}${
            step6Validation
              ? step6Validation.found
                ? " ✓ produto encontrado no cart"
                : ` ✗ produto ESPERADO não encontrado (${step6Validation.observedTitles?.length ?? 0} itens observados)`
              : ""
          }`
        : cartOpenMethod === "already-open"
          ? "Minicart já estava aberto após add-to-cart"
          : "Minicart não pôde ser aberto",
      selectorKey: miniHit ? "minicartTrigger" : undefined,
      usedSelector: miniHit?.selector,
      recoveredByLlm: miniRecovered || undefined,
    });
    reportEnd(6, "open-minicart", step6Status, Date.now() - t6);

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
    // Two scenarios at the start of step 8:
    //
    //   (a) **drawer-mode**: we're still on the product/cart page, the
    //       minicart is a popup/drawer overlay. Look for a "Finalizar"
    //       / "Ir para o checkout" CTA inside that drawer.
    //
    //   (b) **cart-is-a-page mode**: step 6 navigated us to /cart or
    //       /checkout/#/cart (miess prod desktop pattern). We're
    //       already on a checkout subpage. The "next step" CTA here is
    //       labeled differently — "Continuar para pagamento", "Avançar",
    //       "Próxima etapa" — and clicking it advances to /checkout/#/email
    //       or similar. NOT a minicart drawer trigger.
    //
    // Detect (b) by URL containing /checkout, /cart, or /carrinho. In
    // mode (b), skip the drawer-re-open block (there's no minicart on
    // a checkout page) and look for a next-step CTA. In mode (a),
    // re-open the drawer in case it auto-closed during step 7.
    const beforeStep8Url = page.url();
    const alreadyInCheckoutPage = /\/(checkout|cart|carrinho)(\/|#|$|\?)/i.test(beforeStep8Url);
    dlog(ctx, `step 8 go-checkout: beforeUrl=${beforeStep8Url} alreadyInCheckoutPage=${alreadyInCheckoutPage}`);
    if (!alreadyInCheckoutPage) {
      const drawerStillOpen = await firstVisible(page, [
        "[role='dialog']:visible",
        "[aria-modal='true']:visible",
        "[data-minicart][aria-hidden='false']",
        ".minicart--open",
        ".minicart-drawer:not([hidden])",
        "[class*='minicart'][class*='open']",
        "[class*='cart-drawer'][class*='open']",
      ]);
      if (!drawerStillOpen) {
        dlog(ctx, "step 8 go-checkout: drawer appears closed, re-clicking minicart trigger");
        const reTrigger = await firstVisibleLocator(page, selFor(ctx, "minicartTrigger"));
        if (reTrigger) {
          await reTrigger.locator.click({ timeout: 3_000 }).catch(() => undefined);
          await page.waitForTimeout(1_500);
          dlog(ctx, `step 8 go-checkout: re-opened drawer via ${reTrigger.selector}`);
        } else {
          dlog(ctx, "step 8 go-checkout: minicartTrigger not found — drawer state unknown");
        }
      } else {
        dlog(ctx, `step 8 go-checkout: drawer still open (matched ${drawerStillOpen})`);
      }
    }

    // When already on a checkout page, prepend "advance step" CTA
    // patterns to the selector list. These are common across VTEX,
    // FastStore, Shopify checkout and homegrown carts.
    const nextStepSelectors = alreadyInCheckoutPage
      ? [
          // Text-based (most semantic, language-agnostic to button vs link)
          "button:has-text('Continuar para pagamento')",
          "a:has-text('Continuar para pagamento')",
          "button:has-text('Ir para o pagamento')",
          "a:has-text('Ir para o pagamento')",
          "button:has-text('Continuar')",
          "a:has-text('Continuar')",
          "button:has-text('Avançar')",
          "a:has-text('Avançar')",
          "button:has-text('Próxima etapa')",
          "a:has-text('Próxima etapa')",
          "button:has-text('Confirmar')",
          "button:has-text('Finalizar')",
          "a:has-text('Finalizar')",
          // VTEX legacy checkout6.js (/checkout/#/cart) — these IDs/classes
          // are stable across miess, decathlon-br, riachuelo, and most
          // VTEX stores still on checkout6.
          "#cart-to-orderform",
          "#btn-go-to-payment",
          ".btn-go-to-payment",
          "a.btn-place-order",
          "a.orange-btn",
          ".cart-links-bottom a",
          // Generic submit-CTA patterns
          "button[type='submit'][class*='checkout' i]",
          "button[type='submit'][class*='continue' i]",
          "[data-checkout-next]",
          "[data-fs-cart-checkout-button]",
        ]
      : [];
    const baseSelectors = selFor(ctx, "checkoutButton");
    const checkoutSelectors = [...nextStepSelectors, ...baseSelectors];
    dlog(ctx, `step 8 go-checkout: firstVisibleLocator on ${checkoutSelectors.length} selectors${alreadyInCheckoutPage ? ` (${nextStepSelectors.length} next-step prefixed)` : ""}`);
    let checkoutHit = await firstVisibleLocator(page, checkoutSelectors);
    dlog(ctx, `step 8 go-checkout: default match → ${checkoutHit ? `selector=${checkoutHit.selector}` : "null"}`);
    let checkoutRecovered = false;
    if (!checkoutHit && recoveryBudget > 0) {
      const recoveryIntent = alreadyInCheckoutPage
        ? "Já estou no checkout (URL contém /checkout ou /cart). Achar o botão visível que avança pra próxima etapa do checkout (geralmente 'Continuar para pagamento', 'Continuar', 'Avançar', 'Próxima etapa', 'Confirmar', ou similar). NÃO é o ícone do header — é uma CTA primary na página."
        : "Clicar no botão 'Finalizar compra' / 'Ir para o checkout' / 'Finalizar' dentro do drawer/popup do carrinho aberto.";
      dlog(ctx, `step 8 go-checkout: defaults missed, calling attemptRecovery (budget=${recoveryBudget}, mode=${alreadyInCheckoutPage ? "advance-checkout" : "drawer-finalize"})`);
      const recovery = await attemptRecovery(page, ctx, "go-checkout", recoveryIntent, checkoutSelectors);
      dlog(ctx, `step 8 go-checkout: LLM recovery → ${recovery ? `selector=${recovery.selector}` : "null"}`);
      if (recovery) {
        checkoutHit = recovery;
        checkoutRecovered = true;
        recoveryBudget--;
      }
    }
    if (!checkoutHit) {
      dlog(ctx, "step 8 go-checkout: no button found, skipping");
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
      const urlBefore = page.url();
      // If we're already on /checkout, the click is supposed to take us
      // to a *different* checkout subpage (e.g. /checkout/#/cart →
      // /checkout/#/email). Wait for a URL change instead of a generic
      // /checkout match (which is trivially true here).
      const urlChangePredicate = alreadyInCheckoutPage
        ? (u: URL) => u.toString() !== urlBefore
        : /checkout/i;
      await Promise.all([
        page.waitForURL(urlChangePredicate, { timeout: 10_000 }).catch(() => undefined),
        hit.locator.click({ timeout: 5_000 }).catch(() => undefined),
      ]);
      await page.waitForTimeout(1_500);
      const spAfter = screenshotPath(ctx, `pj-8-checkout-reached-${attempt}`);
      await page.screenshot({ path: spAfter, fullPage: false }).catch(() => undefined);
      return { url: page.url(), spBefore, spAfter, clickedText };
    };

    const t8 = Date.now();
    const beforeUrl8 = page.url();
    // Success criterion: URL changed AND the new URL contains a
    // recognizable checkout-flow marker. The "URL changed" half rejects
    // misclicks that bounced back to the start; the "checkout marker"
    // half rejects bare cart pages (`/cart`, `/carrinho`, `/sacola`)
    // since clicking the cart icon brings you there without actually
    // entering the checkout flow.
    //
    // Markers accepted (covers VTEX legacy /checkout, FastStore
    // /checkout, Shopify /checkouts, Wake /pedido, Magento /onepage,
    // Nuvemshop /finalizar, plus various Latin-American checkout
    // platforms that use /pagamento or /payment URLs):
    const CHECKOUT_URL_MARKERS = /\/(checkout|checkouts|finalize|finalizar|pagamento|payment|pedido|order|orderform|onepage|secure|seguro)(\/|#|$|\?|-)/i;
    const isReachedCheckout = (finalUrl: string): boolean => {
      if (finalUrl === beforeUrl8) return false;
      return CHECKOUT_URL_MARKERS.test(finalUrl);
    };
    let attempt = 1;
    dlog(ctx, `step 8 go-checkout: tryCheckoutClick attempt 1 — selector=${checkoutHit.selector}, beforeUrl=${beforeUrl8}`);
    let result = await tryCheckoutClick(checkoutHit, attempt);
    let reachedCheckout = isReachedCheckout(result.url);
    let usedSelector = checkoutHit.selector;
    let clickedText = result.clickedText;
    dlog(ctx, `step 8 go-checkout: attempt 1 result — finalUrl=${result.url} reached=${reachedCheckout} clicked='${clickedText.slice(0, 40).trim()}'`);

    // If we clicked something but the URL didn't change to /checkout, the
    // selector likely picked a button that ISN'T the real checkout CTA.
    // Burn one recovery slot on a fresh LLM call that sees the cart HTML
    // as it stands NOW (post-failed-click) and ask for the actual
    // navigation trigger. This is the "LLM should see the rendered cart,
    // not just the home" path the discovery phase can't take on its own.
    if (!reachedCheckout && recoveryBudget > 0) {
      dlog(ctx, `step 8 go-checkout: attempt 1 missed target — calling attemptRecovery for retry (budget=${recoveryBudget}, mode=${alreadyInCheckoutPage ? "advance-checkout" : "drawer-finalize"})`);
      const retryIntent = alreadyInCheckoutPage
        ? `Já estou no checkout, em ${beforeUrl8}. Cliquei em '${clickedText.slice(0, 40).trim()}' (selector \`${usedSelector}\`), mas a URL não mudou ou foi pra ${result.url}. Achar o botão que avança pra próxima etapa do checkout (Continuar para pagamento, Avançar, Próxima etapa, Confirmar, etc).`
        : `Cliquei em '${clickedText.slice(0, 40).trim()}' (selector \`${usedSelector}\`), mas a URL ficou em ${result.url} e não foi pra /checkout. Achar o botão que de fato navega pra /checkout neste cart/minicart aberto.`;
      const retrySuggestion = await attemptRecovery(
        page,
        ctx,
        "go-checkout-retry",
        retryIntent,
        [usedSelector, ...checkoutSelectors],
      );
      dlog(ctx, `step 8 go-checkout: retry LLM suggestion → ${retrySuggestion ? `selector=${retrySuggestion.selector}` : "null"}`);
      if (retrySuggestion) {
        recoveryBudget--;
        checkoutRecovered = true;
        attempt++;
        dlog(ctx, `step 8 go-checkout: tryCheckoutClick attempt 2 — selector=${retrySuggestion.selector}`);
        const retryResult = await tryCheckoutClick(retrySuggestion, attempt);
        // Always promote the retry to the "current" attempt — it IS the
        // most recent action, so the reported URL, screenshot paths,
        // selector and clicked text must reflect it. Whether the retry
        // *succeeded* is decided by URL match alone.
        result = retryResult;
        usedSelector = retrySuggestion.selector;
        clickedText = retryResult.clickedText;
        reachedCheckout = isReachedCheckout(retryResult.url);
        dlog(ctx, `step 8 go-checkout: attempt 2 result — finalUrl=${retryResult.url} reached=${reachedCheckout} clicked='${retryResult.clickedText.slice(0, 40).trim()}'`);
      }
    } else if (!reachedCheckout) {
      dlog(ctx, `step 8 go-checkout: not retrying — recoveryBudget=${recoveryBudget}`);
    }

    // Once we're on /checkout, validate the SAME product is still
    // listed. This catches cart-state-not-persisted bugs (e.g. cart is
    // session-cookie-scoped and the cookie didn't carry over to the
    // checkout subdomain, or the platform creates a fresh order form
    // on /checkout and the previously-added item didn't survive).
    let step8Validation: StepCapture["cartValidation"];
    if (expectedProductTitle && reachedCheckout) {
      // Give the checkout page a chance to render its line items.
      await page.waitForTimeout(1_500);
      const v = await validateCartContainsTitle(page, expectedProductTitle, ctx);
      let reasonText: string | undefined;
      if (!v.found) {
        if (v.observedTitles.length === 0) {
          const emptyBanner = await detectEmptyCartBanner(page);
          reasonText = emptyBanner
            ? `checkout shows empty cart banner — upstream session lost. Banner: "${emptyBanner}"`
            : "checkout page has no visible line items (selectors may not match markup)";
        } else {
          reasonText = `expected title not found among ${v.observedTitles.length} observed on checkout`;
        }
      }
      step8Validation = {
        expectedTitle: expectedProductTitle,
        found: v.found,
        method: v.method,
        observedTitles: v.observedTitles.slice(0, 8),
        reason: reasonText,
      };
      dlog(ctx, `step 8 go-checkout: checkout validation → found=${v.found} (${v.method})${reasonText ? ` — ${reasonText.slice(0, 80)}` : ""}`);
    }

    // Reach checkout is required; if we reached but the product is
    // missing, that's still a failure because the user wouldn't have
    // anything to pay for.
    const step8Status: StepCapture["status"] = reachedCheckout
      ? step8Validation && !step8Validation.found
        ? "failed"
        : "ok"
      : "failed";
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
      cartValidation: step8Validation,
      actionDescription: `Clicou em${clickedText ? ` '${clickedText.slice(0, 30).trim()}'` : ""} (\`${usedSelector}\`); URL final: ${result.url}${reachedCheckout ? " ✓ atingiu /checkout" : " ✗ não foi pra checkout"}${attempt > 1 ? ` (após ${attempt} tentativas com recovery LLM)` : ""}${step8Validation ? (step8Validation.found ? " ✓ produto persiste no checkout" : ` ✗ produto ESPERADO ausente no checkout (${step8Validation.observedTitles?.length ?? 0} itens observados)`) : ""}`,
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
  dlog(ctx, `  findCategoryUrl: collectCandidateLinks(${selectors.length} selectors) start`);
  const t0 = Date.now();
  const candidates = await collectCandidateLinks(page, selectors, 12);
  dlog(ctx, `  findCategoryUrl: collectCandidateLinks done in ${Date.now() - t0}ms → ${candidates.length} candidates`);
  if (candidates.length === 0) return null;
  dlog(ctx, "  findCategoryUrl: pickCategoryLink LLM call start");
  const picked = await pickCategoryLink(candidates.map((c) => ({ text: c.text, href: c.href })));
  dlog(ctx, `  findCategoryUrl: pickCategoryLink LLM done → ${picked?.href ?? "null"}`);
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

/**
 * Hard total budget for the candidate-link crawl. Each individual
 * Playwright op below has its own tight timeout (count/isVisible) but
 * if the page's V8 engine is wedged (memory leak, infinite hydration
 * loop, etc), CDP messages queue up behind the wedged main thread and
 * `locator.count()` / `isVisible` / `getAttribute` can outlast their
 * declared timeouts. The deadline below short-circuits the whole loop
 * so a hung page can never freeze the parent flow indefinitely.
 */
const COLLECT_CANDIDATES_BUDGET_MS = 15_000;

/** Race a Playwright op against a hard timer, since some CDP-backed ops
 *  outlive their declared timeouts when the page is wedged. */
function withCap<T>(p: Promise<T>, capMs: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), capMs)),
  ]);
}

export async function collectCandidateLinks(
  page: Page,
  selectors: string[],
  limit = 12,
): Promise<{ text: string; href: string; selector: string }[]> {
  const out: { text: string; href: string; selector: string }[] = [];
  const seenHrefs = new Set<string>();
  const deadline = Date.now() + COLLECT_CANDIDATES_BUDGET_MS;
  const expired = () => Date.now() >= deadline;

  for (const sel of selectors) {
    if (out.length >= limit) break;
    if (expired()) break;
    try {
      const elements = page.locator(sel);
      // page.locator.count() has no timeout argument and can hang past
      // page.setDefaultTimeout on a wedged page — cap it manually.
      const count = await withCap(elements.count(), 1_000, 0);
      for (let i = 0; i < count && out.length < limit; i++) {
        if (expired()) break;
        const el = elements.nth(i);
        const visible = await withCap(
          el.isVisible({ timeout: 250 }).catch(() => false),
          400,
          false,
        );
        if (!visible) continue;
        const href = await withCap(el.getAttribute("href").catch(() => null), 400, null);
        if (!href) continue;
        let abs = href;
        try {
          abs = new URL(href, page.url()).toString();
        } catch {
          continue;
        }
        if (seenHrefs.has(abs)) continue;
        seenHrefs.add(abs);
        const text = (await withCap(el.innerText().catch(() => ""), 400, "")).slice(0, 60).trim();
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
 * Patterns that signal a generic page-template title rather than a
 * specific product name. Mostly seen on migrated SPAs that haven't
 * customized SEO meta tags yet — the `<title>` and `og:title` come from
 * the route template ("Página de Produto | Miess") instead of the
 * actual product. We reject these so the test doesn't try to validate
 * the cart against a meaningless string.
 */
const GENERIC_TITLE_PATTERNS = [
  /^p[áa]gina de produto/i,
  /^product page/i,
  /^carregando/i,
  /^loading/i,
  /^undefined/i,
  /^home$/i,
];

function looksGeneric(s: string): boolean {
  const t = s.trim();
  return GENERIC_TITLE_PATTERNS.some((re) => re.test(t));
}

/**
 * Extract the product title from the current PDP, used later to validate
 * that the same product appears in the cart drawer and on the checkout
 * page. Strategy: h1 first (most specific), then JSON-LD Product.name,
 * then platform-specific data attributes, then og:title (filtered for
 * generic template values), then document.title (also filtered).
 */
async function extractProductTitle(page: Page): Promise<string | null> {
  // Wait briefly for the h1 to render — on TanStack/React SPAs the
  // product title section can hydrate slightly after DOMContentLoaded.
  await page.waitForSelector("h1", { timeout: 2_500, state: "attached" }).catch(() => undefined);

  const visibleSelectors = [
    "main h1",
    "h1[class*='product' i]",
    "h1.product-title",
    "[itemprop='name'][data-product-name]",
    "[data-product-name]",
    "[data-fs-product-title]",
    "[itemprop='name']",
    ".vtex-store-components-3-x-productNameContainer",
    "h1",
  ];
  for (const sel of visibleSelectors) {
    try {
      const el = page.locator(sel).first();
      const visible = await withCap(el.isVisible({ timeout: 250 }).catch(() => false), 400, false);
      if (!visible) continue;
      const text = await withCap(el.innerText().catch(() => ""), 500, "");
      const clean = text.trim();
      if (clean.length > 3 && !looksGeneric(clean)) return clean;
    } catch {
      /* try next */
    }
  }
  // JSON-LD Product.name — present in the SSR HTML even when the h1
  // hasn't hydrated yet. Robust against React/SPA hydration timing.
  try {
    const jsonLdName = await withCap(
      page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (const s of scripts) {
          try {
            const data = JSON.parse((s as HTMLScriptElement).textContent ?? "{}");
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
              const product = item?.["@graph"]?.find?.((x: { "@type"?: string }) => x?.["@type"] === "Product") ?? item;
              if (product?.["@type"] === "Product" && typeof product.name === "string") {
                return product.name as string;
              }
            }
          } catch {
            /* skip malformed */
          }
        }
        return null;
      }),
      1_000,
      null,
    );
    if (jsonLdName && jsonLdName.trim().length > 3 && !looksGeneric(jsonLdName)) {
      return jsonLdName.trim();
    }
  } catch {
    /* fall through */
  }
  // og:title — only accept if not generic (some migrated sites have
  // template og:title = "Página de Produto | Site Name").
  try {
    const og = await withCap(
      page.locator("meta[property='og:title']").first().getAttribute("content").catch(() => null),
      500,
      null,
    );
    if (og && og.trim().length > 3 && !looksGeneric(og)) return og.trim();
  } catch {
    /* fall through */
  }
  // Last resort: document.title — also filtered for generic values.
  const docTitle = await withCap(page.title().catch(() => ""), 500, "");
  if (docTitle.trim().length > 3 && !looksGeneric(docTitle)) return docTitle.trim();
  return null;
}

/**
 * Detect whether the cart UI is currently visible (drawer/dialog open, or
 * we already navigated to a cart/checkout page). Used to decide whether
 * step 6 needs to keep trying (click → hover) or has already succeeded.
 */
async function isCartUiVisible(page: Page): Promise<string | null> {
  return firstVisible(page, [
    "[role='dialog']:visible",
    "[aria-modal='true']:visible",
    "[data-minicart][aria-hidden='false']",
    "[data-minicart-open]",
    ".minicart--open",
    ".minicart-drawer:not([hidden])",
    "[class*='minicart'][class*='open']",
    "[class*='cart-drawer'][class*='open']",
    "[class*='drawer-cart']:visible",
  ]);
}

/**
 * Open the minicart with a multi-strategy approach:
 *   1. **click**: most sites. Drawer opens as overlay.
 *   2. **click-navigate**: some sites (miess mobile prod) make the cart
 *      icon a real link that NAVIGATES to /checkout/#/cart or /cart.
 *      We detect this by URL change.
 *   3. **hover**: desktop pattern (miess prod desktop): the minicart
 *      appears as a hover-popup, no click required. Falls back here when
 *      click didn't reveal a drawer and didn't change URL.
 *
 * Returns the method that worked plus the URL after the action.
 */
/**
 * Resolve "is the cart UI revealed?" against the ground truth that
 * matters for the test: can we see the product we just added? Falls
 * back to drawer-markup heuristics when no expected title is provided,
 * for platforms with truly empty/minimal cart UI markup.
 */
async function isCartRevealed(
  page: Page,
  expectedProductTitle: string | null,
): Promise<string | null> {
  // Product-title-found-on-page is the strongest signal — if the item
  // we just added is visible, the cart is open *enough* for the test,
  // even when the actual drawer container uses unfamiliar markup
  // (miess prod legacy minicart popup, custom Wake themes, etc).
  if (expectedProductTitle) {
    const v = await validateCartContainsTitleQuick(page, expectedProductTitle);
    if (v) return `title-found:${v}`;
  }
  return isCartUiVisible(page);
}

/** Lightweight pass of validateCartContainsTitle — single-shot, no
 *  exhaustive selector sweep, returns the first matching selector as
 *  proof of life. Used to decide if a cart UI is "open enough" without
 *  doing the full validation work. */
async function validateCartContainsTitleQuick(
  page: Page,
  expectedTitle: string,
): Promise<string | null> {
  const quickSelectors = [
    "[role='dialog']",
    "[class*='minicart' i]",
    "[class*='cart' i]",
    "[class*='checkout' i]",
    "#cart-fixed",
    "table.cart-items",
  ];
  for (const scope of quickSelectors) {
    try {
      const scopeLoc = page.locator(scope);
      if ((await withCap(scopeLoc.count(), 800, 0)) === 0) continue;
      const text = await withCap(scopeLoc.first().innerText().catch(() => ""), 800, "");
      if (text && titlesMatch(text, expectedTitle)) return scope;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Best-effort dismiss of overlays that commonly land in front of the
 * cart icon right after add-to-cart and intercept clicks/taps:
 *   - "ADICIONADO COM SUCESSO" toast / popover
 *   - cookie consent banner
 *   - generic role="alertdialog"
 *
 * For each match: try a visible close button inside the overlay first,
 * then press Escape as a fallback. Both are non-fatal — overlays that
 * don't react are simply left alone (the force-click below will deal
 * with them by bypassing actionability checks).
 */
async function dismissOverlays(page: Page, ctx: FlowContext): Promise<void> {
  const overlaySelectors = [
    "[class*='cookie' i][class*='banner' i]",
    "[class*='cookie' i][class*='consent' i]",
    "[id*='cookie' i][class*='banner' i]",
    "[role='alertdialog']:visible",
    "[class*='toast' i]:visible",
    "[class*='snackbar' i]:visible",
    "[class*='added-to-cart' i]:visible",
    "[class*='product-added' i]:visible",
  ];
  let dismissedAny = false;
  for (const sel of overlaySelectors) {
    try {
      const overlay = page.locator(sel).first();
      if (!(await withCap(overlay.isVisible({ timeout: 200 }).catch(() => false), 400, false))) continue;
      // Try to find a close affordance inside the overlay.
      const closer = overlay.locator(
        "button[aria-label*='close' i], button[aria-label*='fechar' i], button[class*='close' i], [data-close], [aria-label='Close']",
      ).first();
      if (await withCap(closer.isVisible({ timeout: 200 }).catch(() => false), 400, false)) {
        await closer.click({ timeout: 1_500 }).catch(() => undefined);
        dismissedAny = true;
        continue;
      }
      // Fallback: Escape key. Works for most modal dialogs.
      await page.keyboard.press("Escape").catch(() => undefined);
      dismissedAny = true;
    } catch {
      /* try next */
    }
  }
  if (dismissedAny) {
    dlog(ctx, "  openMinicart: dismissed overlay(s) before interacting");
    await page.waitForTimeout(500);
  }
}

/**
 * Wait for VTEX/FastStore checkout APIs to render the cart line items
 * before validation runs. Without this, `page.goto('/checkout/#/cart')`
 * settles on `load`/`networkidle` long before the orderForm XHR resolves
 * and validation sees an empty DOM.
 *
 * Either signal (the orderForm XHR completing OR the first cart-item
 * selector becoming visible) is sufficient evidence the cart hydrated.
 * Race them with `Promise.race` so a missed XHR (non-VTEX cart, regex
 * miss) doesn't force the test to wait 8s for the slowest probe — the
 * faster signal returns immediately. Both probes have `.catch(() => undefined)`
 * fallbacks, so even if neither fires they still resolve at the 8s
 * Playwright timeout — Promise.race can't hang. No outer fallback
 * needed (a separate timeout shorter than 8s would fire too early
 * and cause premature validation against a still-empty DOM).
 */
async function waitForCartHydration(page: Page): Promise<void> {
  await Promise.race([
    page
      .waitForResponse(
        (r) => /\/api\/checkout\/pub\/orderForm|orderForm|cart\/api/i.test(r.url()) && r.ok(),
        { timeout: 8_000 },
      )
      .catch(() => undefined),
    page
      .waitForSelector(".cart-items, [class*='cart-item' i], #cart-fixed .item, [data-cart-item]", { timeout: 8_000 })
      .catch(() => undefined),
  ]);
  await page.waitForTimeout(800);
}

async function openMinicart(
  page: Page,
  trigger: { locator: Locator; selector: string },
  ctx: FlowContext,
  expectedProductTitle: string | null,
): Promise<{ method: NonNullable<StepCapture["cartOpenMethod"]>; url: string; visibleMarker: string | null }> {
  const beforeUrl = page.url();
  // Toast/popover from the add-to-cart in step 5 can cover the cart
  // icon. Active dismissal first (Escape + click close), then a short
  // settle for animations.
  await dismissOverlays(page, ctx);
  await page.waitForTimeout(800);
  // Maybe a drawer is already open from earlier interaction.
  const alreadyOpen = await isCartRevealed(page, expectedProductTitle);
  if (alreadyOpen) {
    dlog(ctx, `  openMinicart: already-open (matched ${alreadyOpen})`);
    return { method: "already-open", url: beforeUrl, visibleMarker: alreadyOpen };
  }
  // Capture the href up-front for the page.goto fallback path below.
  // We only use it when click and hover both fail to reveal the cart.
  const triggerHref = await trigger.locator.getAttribute("href").catch(() => null);
  const hrefHasCartTarget = !!triggerHref && /\/(checkout|cart|carrinho)/i.test(triggerHref);

  // Strategy 1: hover FIRST when the trigger looks hover-capable
  // (desktop with mouse), since on miess prod and many VTEX stores the
  // same anchor opens a minicart popup on hover but navigates away on
  // click. We don't want to leave the PDP unless we have to.
  if (ctx.viewport === "desktop") {
    dlog(ctx, `  openMinicart: trying hover first on ${trigger.selector}${triggerHref ? ` (href=${triggerHref})` : ""}`);
    await trigger.locator.hover({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    const hoverOpened = await isCartRevealed(page, expectedProductTitle);
    if (hoverOpened) {
      dlog(ctx, `  openMinicart: hover opened drawer (${hoverOpened})`);
      return { method: "hover", url: page.url(), visibleMarker: hoverOpened };
    }
  }

  // Strategy 2a (mobile only): real touch event via tap(). Headless
  // mobile click() on an anchor often gets swallowed by JS overlay
  // handlers because synthetic mouse events differ from touch events;
  // a real tap dispatches `touchstart`/`touchend` which most VTEX
  // stores treat as legitimate navigation triggers.
  if (ctx.viewport === "mobile") {
    dlog(ctx, `  openMinicart: trying tap (mobile) on ${trigger.selector}`);
    await Promise.all([
      page.waitForURL((url) => url.toString() !== beforeUrl, { timeout: 4_000 }).catch(() => undefined),
      trigger.locator.tap({ timeout: 4_000 }).catch(() => undefined),
    ]);
    if (page.url() !== beforeUrl) {
      await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => undefined);
      await waitForCartHydration(page);
      dlog(ctx, `  openMinicart: tap navigated → ${page.url()} (settled)`);
      return { method: "click-navigate", url: page.url(), visibleMarker: null };
    }
    await page.waitForTimeout(800);
    const tapOpened = await isCartRevealed(page, expectedProductTitle);
    if (tapOpened) {
      dlog(ctx, `  openMinicart: tap opened drawer (${tapOpened})`);
      return { method: "click", url: page.url(), visibleMarker: tapOpened };
    }
  }

  // Strategy 2b: force click. `force: true` bypasses Playwright's
  // actionability check, so a transparent overlay or zero-pointer-event
  // sibling on top of the cart icon doesn't make the click silently
  // miss its target. Race against waitForURL to catch navigation.
  dlog(ctx, `  openMinicart: trying force-click on ${trigger.selector}${triggerHref ? ` (href=${triggerHref})` : ""}`);
  await Promise.all([
    page.waitForURL((url) => url.toString() !== beforeUrl, { timeout: 4_000 }).catch(() => undefined),
    trigger.locator.click({ force: true, timeout: 4_000 }).catch(() => undefined),
  ]);
  const afterClickUrl = page.url();
  if (afterClickUrl !== beforeUrl) {
    await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => undefined);
    await waitForCartHydration(page);
    dlog(ctx, `  openMinicart: click navigated → ${page.url()} (settled)`);
    return { method: "click-navigate", url: page.url(), visibleMarker: null };
  }
  // No nav, give the drawer animation a beat to play.
  await page.waitForTimeout(1_500);
  const clickOpened = await isCartRevealed(page, expectedProductTitle);
  if (clickOpened) {
    dlog(ctx, `  openMinicart: click opened drawer (${clickOpened})`);
    return { method: "click", url: afterClickUrl, visibleMarker: clickOpened };
  }
  // Strategy 3 (mobile only — desktop already hovered above): hover as
  // fallback. On mobile this is mostly a no-op but cheap.
  if (ctx.viewport !== "desktop") {
    dlog(ctx, `  openMinicart: click didn't reveal cart, trying hover (mobile)`);
    await trigger.locator.hover({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    const hoverOpened = await isCartRevealed(page, expectedProductTitle);
    if (hoverOpened) {
      dlog(ctx, `  openMinicart: hover opened drawer (${hoverOpened})`);
      return { method: "hover", url: page.url(), visibleMarker: hoverOpened };
    }
  }
  // Strategy 4: direct goto fallback. The trigger is an `<a>` with a
  // checkout-related href and the click was intercepted (toast overlay,
  // JS handler that preventDefault'd, etc). Since a real user clicking
  // that link would land on the same URL, we honor that intent with an
  // explicit goto. NOT used when the trigger has no useful href.
  if (hrefHasCartTarget && triggerHref) {
    const targetUrl = (() => {
      try {
        return new URL(triggerHref, page.url()).toString();
      } catch {
        return null;
      }
    })();
    if (targetUrl) {
      dlog(ctx, `  openMinicart: all interactive strategies failed but trigger has cart href, navigating directly to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: "load", timeout: 15_000 }).catch(() => undefined);
      await waitForCartHydration(page);
      if (page.url() !== beforeUrl) {
        dlog(ctx, `  openMinicart: goto fallback landed on ${page.url()}`);
        return { method: "click-navigate", url: page.url(), visibleMarker: null };
      }
    }
  }
  dlog(ctx, "  openMinicart: failed — no cart revealed by hover/click/goto");
  return { method: "failed", url: page.url(), visibleMarker: null };
}

/**
 * Normalize a title for fuzzy comparison: lowercase, strip punctuation,
 * collapse whitespace. The cart label is typically a slightly trimmed
 * version of the PDP title ("Lubrificante 60g" vs "Love Lub Lubrificante
 * 60g — La Pimienta"), so we accept substring matches in either
 * direction.
 */
function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[®©™]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titlesMatch(observed: string, expected: string): boolean {
  const o = normalizeTitle(observed);
  const e = normalizeTitle(expected);
  if (!o || !e) return false;
  if (o === e) return true;
  // Substring either direction — handles "brand prefix" or "size suffix"
  // appearing in only one of the two. Minimum overlap of 12 chars guards
  // against tiny common words ("kit", "novo") false-matching.
  if (e.length >= 12 && o.includes(e)) return true;
  if (o.length >= 12 && e.includes(o)) return true;
  return false;
}

/**
 * Validate that a given product title appears among the cart line items
 * currently visible on the page (drawer or full cart/checkout page).
 *
 * Strategy:
 *   1. Try common selectors for cart line item titles. Collect text from
 *      visible matches.
 *   2. Match each observed title against the expected one (normalized
 *      substring, see titlesMatch).
 *   3. If no match, return found=false plus the observed titles so the
 *      caller can decide whether to invoke an LLM fallback.
 */
async function validateCartContainsTitle(
  page: Page,
  expectedTitle: string,
  ctx: FlowContext,
): Promise<{ found: boolean; observedTitles: string[]; method: "selector" | "none" }> {
  const titleSelectors = [
    // Generic data attributes (scoped to cart/checkout context — the
    // unscoped `[data-product-name]` would also match the PDP <h1> on
    // sites that didn't navigate away, producing a false-positive
    // "cart contains product" when validation runs while still on the
    // product page).
    "[data-cart-item-name]",
    "[data-cart-item] [class*='title' i]",
    "[data-cart-item] [class*='name' i]",
    "[class*='cart' i] [data-product-name]",
    "[role='dialog'] [data-product-name]",
    "[class*='checkout' i] [data-product-name]",
    "[class*='minicart' i] [data-product-name]",
    "[data-testid='cart-item-name']",
    "[data-testid='product-name']",
    // Drawer / dialog context
    "[role='dialog'] li [class*='product' i]",
    "[role='dialog'] li [class*='name' i]",
    "[role='dialog'] li [class*='title' i]",
    "[role='dialog'] a[href*='/p']",
    // class-name heuristics
    "[class*='minicart' i] [class*='item' i] [class*='name' i]",
    "[class*='minicart' i] [class*='item' i] [class*='title' i]",
    "[class*='cart-item' i] [class*='name' i]",
    "[class*='cart-item' i] [class*='title' i]",
    "[class*='checkout' i] [class*='product' i] [class*='name' i]",
    // VTEX legacy & modern checkout class names
    ".vtex-minicart-2-x-itemNameContainer",
    ".vtex-checkout-summary-0-x-itemName",
    ".product-name",
    ".item-name",
    "a.product-name",
    // VTEX legacy checkout (`/checkout/#/cart` rendered by checkout6.js)
    ".cart-items .item-name",
    "tr.product-item .item-name",
    "tr.cart-item .item-name",
    "table.cart-items td a",
    // VTEX legacy hover-popup minicart (.cart-fixed / #cart-fixed)
    "#cart-fixed .item .product-name",
    "#cart-fixed .item-name",
    ".cart-fixed .item-name",
    ".cart-fixed .product-name",
    "#cart-fixed li a",
    "#minicart-content .item-name",
    // FastStore / Wake
    "[data-fs-cart-item-summary-title]",
    "[data-fs-cart-item-image] + * a",
    // Last resort: any link to a /p product page inside the cart/checkout area
    "[class*='cart' i] a[href*='/p']",
    "[class*='checkout' i] a[href*='/p']",
  ];
  // Single sweep across the selector list — returns at first selector
  // with visible matches, or empty when nothing renders yet.
  const sweepTitles = async (): Promise<string[]> => {
    const observed: string[] = [];
    for (const sel of titleSelectors) {
      try {
        const loc = page.locator(sel);
        const count = await withCap(loc.count(), 1_000, 0);
        const limit = Math.min(count, 10);
        for (let i = 0; i < limit; i++) {
          const el = loc.nth(i);
          const visible = await withCap(el.isVisible({ timeout: 200 }).catch(() => false), 400, false);
          if (!visible) continue;
          const text = await withCap(el.innerText().catch(() => ""), 500, "");
          const clean = text.trim().slice(0, 200);
          if (clean.length > 2) observed.push(clean);
        }
        if (observed.length > 0) return observed; // first selector with hits wins
      } catch {
        /* try next */
      }
    }
    return observed;
  };

  let observed = await sweepTitles();
  // The cart-items XHR can still be in flight when we get here (especially
  // right after `page.goto('/checkout/#/cart')`). One second-chance pass
  // with a 2s wait catches the common "rendered slightly late" case
  // without bloating happy-path latency.
  if (observed.length === 0) {
    dlog(ctx, "  validateCartContainsTitle: 0 titles on first pass, retrying after 2s");
    await page.waitForTimeout(2_000);
    observed = await sweepTitles();
  }
  dlog(ctx, `  validateCartContainsTitle: observed ${observed.length} titles ${observed.length ? `[${observed.slice(0, 3).map((t) => t.slice(0, 30)).join(" | ")}${observed.length > 3 ? " | …" : ""}]` : ""}`);
  if (observed.length === 0) {
    return { found: false, observedTitles: [], method: "none" };
  }
  const found = observed.some((o) => titlesMatch(o, expectedTitle));
  return { found, observedTitles: observed, method: "selector" };
}

/**
 * Detect whether the current page is showing an empty-cart banner. Used
 * in step 6/8 validation to distinguish "selectors didn't match the
 * markup" from "cart is genuinely empty because upstream add-to-cart
 * didn't persist to the session". Returns the matched text (truncated)
 * or null.
 */
async function detectEmptyCartBanner(page: Page): Promise<string | null> {
  const bannerSelectors = [
    ":text-matches('carrinho.*vazio', 'i')",
    ":text-matches('seu carrinho está vazio', 'i')",
    ":text-matches('empty cart', 'i')",
    ":text-matches('cart is empty', 'i')",
    ":text-matches('nenhum item.*carrinho', 'i')",
    "[class*='empty' i][class*='cart' i]",
    "[class*='cart-empty' i]",
  ];
  for (const sel of bannerSelectors) {
    try {
      const loc = page.locator(sel).first();
      if (await withCap(loc.isVisible({ timeout: 300 }).catch(() => false), 500, false)) {
        const text = await withCap(loc.innerText().catch(() => ""), 500, "");
        if (text.trim()) return text.trim().slice(0, 120);
      }
    } catch {
      /* try next */
    }
  }
  return null;
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
