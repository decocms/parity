import type { BrowserContext, Locator, Page } from "playwright";
import type { Platform } from "../learned/platform.ts";
import type { LearnedSelectors } from "../learned/repo.ts";
import { pickCategoryLink } from "../llm/pick-plp.ts";
import { suggestRecovery } from "../llm/recover-step.ts";
import { resolveSearchTerms } from "../llm/resolve-search-terms.ts";
import type {
  FlowCapture,
  FlowName,
  PageCapture,
  ParityRc,
  Side,
  StepCapture,
  Viewport,
} from "../types/schema.ts";
import { stabilizeCarousels } from "./carousel-stabilizer.ts";
import { capturePage } from "./collect.ts";
import { selectorsFor } from "./selectors.ts";
import type { SelectorKey } from "./selectors.ts";

/**
 * Stabilize any carousel/slider on the page and then take a screenshot.
 * All step screenshots in the journey go through this so that prod and
 * cand frames match at compare-time (issue #22).
 *
 * The stabilizer is raced against a 3s cap — if the page's JS queue is
 * wedged we'd rather snap a possibly-mis-framed shot than burn the
 * step's budget here. Cubic flagged the unbounded await on PR #32.
 * Errors are swallowed for the same reason: a screenshot missing is
 * worse than a screenshot mis-timed.
 */
async function screenshotStable(
  page: Page,
  opts: { path: string; fullPage?: boolean },
): Promise<void> {
  await Promise.race([
    stabilizeCarousels(page).catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  await page
    .screenshot({ path: opts.path, fullPage: opts.fullPage ?? false })
    .catch(() => undefined);
}

export type StepProgressEvent =
  | { phase: "start"; name: string; index: number; total: number }
  | {
      phase: "end";
      name: string;
      index: number;
      total: number;
      status: StepCapture["status"];
      durationMs: number;
      note?: string;
    };

export interface FlowContext {
  baseUrl: string;
  side: Side;
  viewport: Viewport;
  rc: ParityRc;
  ctx: BrowserContext;
  /** Output dir for screenshots/HARs of this flow */
  outDir: string;
  /** Stable identifier for the parent run — used to seed deterministic
   *  artifacts (e.g. the unicode no-results search term). Optional so
   *  legacy callers that didn't propagate it still work. */
  runId?: string;
  /** Optional learned selectors library (cascade integration) */
  learned?: LearnedSelectors;
  /** Optional detected platform for the prod side */
  platform?: Platform;
  /** Max LLM-driven step recoveries per flow */
  recoveryBudget?: number;
  /** Optional progress callback (each step start/end) */
  onStep?: (event: StepProgressEvent) => void;
  /**
   * When true, prod-side steps that get diagnosed as "cart genuinely
   * empty due to session/cookie quirk" (see `detectEmptyCartBanner`)
   * are marked `skipped` instead of `failed` — BUT only when prod and
   * cand agree on `cartRevealMode`. If the modes diverge, the flag is
   * a no-op so we never mask a real markup regression (issue #12).
   */
  acceptProdQuirks?: boolean;
}

const PURCHASE_JOURNEY_TOTAL_STEPS = 9;

const DEBUG_PARITY = process.env.DEBUG_PARITY === "1" || process.env.DEBUG_PARITY === "true";
const DEBUG_START = Date.now();
function dlog(ctx: FlowContext, msg: string): void {
  if (!DEBUG_PARITY) return;
  const elapsed = ((Date.now() - DEBUG_START) / 1000).toFixed(1);
  process.stderr.write(`[+${elapsed}s ${ctx.viewport}/${ctx.side}] ${msg}\n`);
}

/** Race a Playwright op against a hard timer, since some CDP-backed ops
 *  outlive their declared timeouts when the page is wedged. */
function withCap<T>(p: Promise<T>, capMs: number, fallback: T): Promise<T> {
  return Promise.race([
    p.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), capMs)),
  ]);
}

const VARIANT_REQUIRED_TEXT_PATTERNS: RegExp[] = [
  /selecione um produto/i,
  /selecione um tamanho/i,
  /selecione uma cor/i,
  /selecione uma op[cç][aã]o/i,
  /select a size/i,
  /select a color/i,
  /select an option/i,
  /choose an option/i,
  /please select/i,
  /select size/i,
  /select color/i,
];

const ADD_TO_CART_ERROR_PATTERNS: RegExp[] = [
  ...VARIANT_REQUIRED_TEXT_PATTERNS,
  /estoque esgotado/i,
  /out of stock/i,
  /indispon[ií]vel/i,
  /unavailable/i,
];

const ADD_TO_CART_SUCCESS_PATTERNS: RegExp[] = [
  /produto adicionado/i,
  /adicionado ao carrinho/i,
  /adicionado [aà]\s+sacola/i,
  /added to cart/i,
  /added to bag/i,
  /item added/i,
  /successfully added/i,
];

function selFor(ctx: FlowContext, key: SelectorKey): string[] {
  return selectorsFor(key, { rc: ctx.rc, learned: ctx.learned, platform: ctx.platform });
}

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
 * capture, plp/pdp add a navigation step, purchase-journey runs 9 steps.
 * Each individual step has its own timeout caps; this is the safety net
 * for the case where those caps misbehave.
 */
const FLOW_DEADLINE_MS: Record<FlowName, number> = {
  homepage: 90_000,
  plp: 180_000,
  pdp: 240_000,
  "purchase-journey": 420_000, // 9 steps × ~30s + LLM recovery + variant heuristic scroll
  search: 300_000, // 6 steps (home + autocomplete + results + no-results + empty)
  "cart-interactions": 240_000, // 7 steps (seed via PJ + qty + coupon + remove)
  login: 180_000, // 5 steps (gated, only with credentials)
};

/**
 * Run a named flow. Returns all pages visited and (for purchase-journey) ordered steps.
 */
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
      case "search": {
        const { pages, steps } = await flowSearch(ctx);
        return finalize(flow, ctx, pages, steps, start);
      }
      case "cart-interactions": {
        const { pages, steps } = await flowCartInteractions(ctx);
        return finalize(flow, ctx, pages, steps, start);
      }
      case "login": {
        const { pages, steps } = await flowLogin(ctx);
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
  let cleanup: Promise<unknown> = Promise.resolve();
  const timeoutPromise = new Promise<FlowCapture>((resolve) => {
    timer = setTimeout(() => {
      const pages = ctx.ctx.pages();
      // Seal the timeout result FIRST, synchronously. Closing pages
      // makes any in-flight Playwright op inside `inner()` reject with
      // "Target closed" almost immediately; if we awaited those closes
      // before resolving, Promise.race could pick up the inner
      // rejection first and make runFlow throw instead of returning
      // this timeout FlowCapture.
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
              actionDescription: `[flow-timeout] flow "${flow}" excedeu ${deadlineMs}ms — captura abortada pela safety net externa, ${pages.length} page(s) fechada(s) para liberar o contexto.`,
            },
          ],
          start,
        ),
      );
      // Kick off close on every page in the BrowserContext. Cap each
      // close at 5s so the cleanup awaitable always resolves.
      const CLOSE_CAP_MS = 5_000;
      const cappedClose = (p: (typeof pages)[number]): Promise<void> =>
        Promise.race([
          p.close().catch(() => undefined),
          new Promise<void>((resolveClose) => setTimeout(resolveClose, CLOSE_CAP_MS)),
        ]);
      cleanup = Promise.allSettled(pages.map(cappedClose));
    }, deadlineMs);
  });

  try {
    const result = await Promise.race([innerPromise, timeoutPromise]);
    await cleanup;
    return result;
  } finally {
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

interface FlowResult {
  pages: PageCapture[];
  steps: StepCapture[];
}

async function flowPurchaseJourney(ctx: FlowContext): Promise<PurchaseJourneyResult> {
  const pages: PageCapture[] = [];
  const steps: StepCapture[] = [];
  const page = await ctx.ctx.newPage();
  // Mutable ref so any nested helper that calls the LLM can decrement
  // the shared budget without prop-drilling and reassignment.
  const budget = { remaining: ctx.recoveryBudget ?? 5 };
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
    const step1Status: StepCapture["status"] =
      homeCap.status >= 200 && homeCap.status < 400 ? "ok" : "failed";
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
    steps[steps.length - 1]!.actionDescription =
      `Navegou pra home \`${ctx.baseUrl}\` (HTTP ${homeCap.status})`;
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
    const step2Status: StepCapture["status"] =
      plpCap.status >= 200 && plpCap.status < 400 ? "ok" : "failed";
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
    steps[steps.length - 1]!.actionDescription =
      `Navegou pra categoria \`${plpHit.url}\` (via \`${plpHit.selector}\`)`;
    steps[steps.length - 1]!.beforeUrl = ctx.baseUrl;

    // Step 3: enter PDP
    reportStart(3, "enter-pdp");
    let pdpHit = await findProductUrl(page, ctx);
    let pdpRecoveredByLlm = false;
    if (!pdpHit && budget.remaining > 0) {
      // No product card matched. Ask the LLM to find an anchor that leads
      // to a product detail page, then read its href to navigate.
      const html = await page.content().catch(() => "");
      if (html) {
        const suggestion = await suggestRecovery({
          stepName: "enter-pdp",
          intendedAction:
            "Encontrar um link <a> que leve para a página de detalhes (PDP) de algum produto listado na PLP atual",
          html,
          alreadyTried: selFor(ctx, "productCard"),
        });
        if (suggestion) {
          budget.remaining--;
          try {
            const el = page.locator(suggestion.selector).first();
            if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
              const href = await el.getAttribute("href");
              if (href) {
                const abs = new URL(href, page.url()).toString();
                pdpHit = { url: abs, selector: suggestion.selector };
                pdpRecoveredByLlm = true;
              }
            }
          } catch {
            /* invalid selector */
          }
        }
      }
    }
    if (!pdpHit) {
      steps.push(makeSkipStep(3, "enter-pdp", ctx, "no product card found (recovery exhausted)"));
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
    const step3Status: StepCapture["status"] =
      pdpCap.status >= 200 && pdpCap.status < 400 ? "ok" : "failed";
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
      recoveredByLlm: pdpRecoveredByLlm || undefined,
    });
    reportEnd(3, "enter-pdp", step3Status, Date.now() - t3);
    steps[steps.length - 1]!.actionDescription =
      `Abriu PDP \`${pdpHit.url}\` (via \`${pdpHit.selector}\`${pdpRecoveredByLlm ? " — recovery LLM" : ""})`;
    steps[steps.length - 1]!.beforeUrl = plpHit.url;

    // Pull the product title while we're still on the PDP — used later
    // (steps 7 and 9) to verify the SAME product shows up in the cart
    // drawer and on the checkout page. Validates the cart actually has
    // what we added (not a phantom item, not empty due to lost session).
    const expectedProductTitle = await extractProductTitle(page);
    dlog(
      ctx,
      `step 3 enter-pdp: extracted product title → ${expectedProductTitle ? `"${expectedProductTitle.slice(0, 60)}"` : "null"}`,
    );
    if (expectedProductTitle) {
      steps[steps.length - 1]!.detail = {
        ...(steps[steps.length - 1]!.detail ?? {}),
        productTitle: expectedProductTitle,
      };
    }

    // Step 4: select variant (size/color/quantity) — non-critical, makes the
    // flow work against stores that gate the buy button on a SKU selection.
    reportStart(4, "select-variant");
    const t4 = Date.now();
    const beforeUrl4 = page.url();
    const spBefore4 = screenshotPath(ctx, "pj-4-select-variant-before");
    await screenshotStable(page, { path: spBefore4, fullPage: false });
    const variantResult = await selectVariant(page, ctx);
    let variantLlmAction: StepActionResult | null = null;
    // LLM fallback ONLY when the page explicitly demands a variant choice
    // and the heuristic found nothing. This avoids burning budget on
    // single-SKU PDPs where the heuristic correctly skips.
    if (
      variantResult.actions.length === 0 &&
      variantResult.variantRequired &&
      budget.remaining > 0
    ) {
      variantLlmAction = await attemptStepAction({
        page,
        ctx,
        stepName: "select-variant",
        intendedAction:
          "Selecionar uma variante disponível (tamanho, cor, sabor) ou clicar no botão '+' para incrementar a quantidade da primeira variante listada na PDP. Não clique no botão de comprar.",
        selectorKey: "quantityIncrement",
        action: "click",
        recoveryBudget: budget,
      });
    }
    const sp4 = screenshotPath(ctx, "pj-4-select-variant");
    await screenshotStable(page, { path: sp4, fullPage: false });
    if (variantResult.actions.length > 0 || variantLlmAction?.performed) {
      const llmDesc = variantLlmAction?.performed
        ? `Recovery LLM: ${variantLlmAction.action} em \`${variantLlmAction.selector}\``
        : null;
      const desc =
        variantResult.actions.length > 0
          ? variantResult.actions.join("; ")
          : (llmDesc ?? "(variante selecionada)");
      steps.push({
        step: 4,
        name: "select-variant",
        side: ctx.side,
        viewport: ctx.viewport,
        status: "ok",
        durationMs: Date.now() - t4,
        url: page.url(),
        screenshotPath: sp4,
        screenshotBeforePath: spBefore4,
        beforeUrl: beforeUrl4,
        actionDescription:
          llmDesc && variantResult.actions.length > 0 ? `${desc}; ${llmDesc}` : desc,
        selectorKey: variantLlmAction?.performed
          ? "quantityIncrement"
          : variantResult.primarySelectorKey,
        usedSelector: variantLlmAction?.performed
          ? variantLlmAction.selector
          : variantResult.primarySelector,
        recoveredByLlm: variantLlmAction?.recoveredByLlm || undefined,
        detail: { actions: variantResult.actions, llmRecovery: !!variantLlmAction?.performed },
      });
      reportEnd(4, "select-variant", "ok", Date.now() - t4);
    } else {
      const skipNote = variantResult.variantRequired
        ? "variant required by store but no selectors matched (LLM recovery also failed)"
        : "no variant selectors found on PDP (assuming single-SKU product)";
      steps.push(makeSkipStep(4, "select-variant", ctx, skipNote));
      reportEnd(4, "select-variant", "skipped", 0, skipNote);
    }

    // Step 5 (conditional): shipping calc on PDP
    reportStart(5, "shipping-calc-pdp");
    let cepInputPdp = await firstVisible(page, selFor(ctx, "cepInputPdp"));
    let cepPdpRecoveredByLlm = false;
    if (!cepInputPdp && budget.remaining > 0) {
      // LLM fallback for stores with non-standard CEP input on PDP.
      const html = await page.content().catch(() => "");
      if (html) {
        const suggestion = await suggestRecovery({
          stepName: "shipping-calc-pdp",
          intendedAction:
            "Encontre o <input> de CEP (código postal de ENDEREÇO de entrega) na PDP, usado pra CALCULAR FRETE — placeholder normalmente é 'CEP', 'Digite seu CEP', 'Cód. postal', 'Postal code', aria-label='CEP' ou name='zip'/'cep'/'postal'. **NÃO** retorne o input de CUPOM de desconto / código promocional / 'Digite o cupom' / 'Insira código' — esses são pra desconto, não pra frete.",
          html,
          alreadyTried: selFor(ctx, "cepInputPdp"),
        });
        if (suggestion) {
          budget.remaining--;
          const el = page.locator(suggestion.selector).first();
          if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
            cepInputPdp = suggestion.selector;
            cepPdpRecoveredByLlm = true;
          }
        }
      }
    }
    if (cepInputPdp) {
      const t5 = Date.now();
      const beforeUrl5 = page.url();
      const spBefore5 = screenshotPath(ctx, "pj-5-shipping-pdp-before");
      await screenshotStable(page, { path: spBefore5, fullPage: false });
      const ok = await fillCep(page, cepInputPdp, ctx.rc.cep);
      const sp = screenshotPath(ctx, "pj-5-shipping-pdp");
      await screenshotStable(page, { path: sp, fullPage: false });
      const step5Status: StepCapture["status"] = ok ? "ok" : "failed";
      steps.push({
        step: 5,
        name: "shipping-calc-pdp",
        side: ctx.side,
        viewport: ctx.viewport,
        status: step5Status,
        durationMs: Date.now() - t5,
        url: page.url(),
        screenshotPath: sp,
        screenshotBeforePath: spBefore5,
        beforeUrl: beforeUrl5,
        actionDescription: `Preencheu CEP '${ctx.rc.cep}' no input \`${cepInputPdp}\`${cepPdpRecoveredByLlm ? " (via recovery LLM)" : ""}`,
        detail: { cepUsed: ctx.rc.cep },
        selectorKey: "cepInputPdp",
        usedSelector: cepInputPdp,
        recoveredByLlm: cepPdpRecoveredByLlm || undefined,
      });
      reportEnd(5, "shipping-calc-pdp", step5Status, Date.now() - t5);
    } else {
      steps.push(
        makeSkipStep(5, "shipping-calc-pdp", ctx, "no CEP input on PDP (recovery exhausted)"),
      );
      reportEnd(5, "shipping-calc-pdp", "skipped", 0, "no CEP input on PDP");
    }

    // Step 6: add to cart (with LLM recovery + post-click validation)
    reportStart(6, "add-to-cart");
    let buyHit = await firstVisibleLocator(page, selFor(ctx, "buyButton"));
    let buyRecovered = false;
    if (!buyHit && budget.remaining > 0) {
      const recovery = await attemptRecovery(
        page,
        ctx,
        "add-to-cart",
        "Clicar no botão de comprar/adicionar ao carrinho",
        selFor(ctx, "buyButton"),
      );
      if (recovery) {
        buyHit = recovery;
        buyRecovered = true;
        budget.remaining--;
      }
    }
    if (!buyHit) {
      steps.push(makeSkipStep(6, "add-to-cart", ctx, "no buy button found (recovery exhausted)"));
      reportEnd(6, "add-to-cart", "skipped", 0, "no buy button found");
      return { pages, steps };
    }
    const t6 = Date.now();
    const beforeUrl6 = page.url();
    const spBefore6 = screenshotPath(ctx, "pj-6-add-cart-before");
    await screenshotStable(page, { path: spBefore6, fullPage: false });
    const cartCountBefore = await readCartCount(page, ctx);
    const buyText = await buyHit.locator.innerText().catch(() => "");
    await buyHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
    let validation = await validateAddToCart(page, ctx, cartCountBefore, beforeUrl6);

    // If the click triggered a "select a variant" warning, the variant
    // picker is now guaranteed to be rendered (the warning is shown next
    // to it). Try the heuristic; if it fails and budget allows, ask the
    // LLM where the variant picker is, then retry the buy click once.
    let variantRetryNote: string | undefined;
    if (
      validation.status === "failed" &&
      validation.errorText &&
      VARIANT_REQUIRED_TEXT_PATTERNS.some((re) => re.test(validation.errorText!))
    ) {
      const retryHit = await findAndIncrementZeroQtyInput(page, ctx);
      if (retryHit) {
        variantRetryNote = `Retry: ${retryHit.description}`;
      } else if (budget.remaining > 0) {
        const llmRetry = await attemptStepAction({
          page,
          ctx,
          stepName: "add-to-cart-retry-variant",
          intendedAction:
            "A loja rejeitou o add-to-cart com a mensagem 'Selecione um produto/tamanho/cor'. Encontre o picker de variante visível e selecione UMA opção (clicar num swatch, em '+' ao lado de uma quantidade '0', em um botão de tamanho). Não clique no botão de comprar.",
          selectorKey: "quantityIncrement",
          action: "click",
          recoveryBudget: budget,
        });
        if (llmRetry.performed) {
          variantRetryNote = `Retry via LLM: ${llmRetry.action} em \`${llmRetry.selector}\``;
        }
      }
      if (variantRetryNote) {
        await page.waitForTimeout(500);
        await buyHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
        validation = await validateAddToCart(page, ctx, cartCountBefore, beforeUrl6);
      }
    }

    const sp6 = screenshotPath(ctx, "pj-6-add-cart");
    await screenshotStable(page, { path: sp6, fullPage: false });
    const buyActionDesc = `Clicou no botão${buyText ? ` '${buyText.slice(0, 40).trim()}'` : ""} (\`${buyHit.selector}\`)${buyRecovered ? " — selector veio de recovery LLM" : ""}`;
    const fullActionDesc = variantRetryNote
      ? `${buyActionDesc} — ${variantRetryNote} — ${validation.note}`
      : `${buyActionDesc} — ${validation.note}`;
    steps.push({
      step: 6,
      name: "add-to-cart",
      side: ctx.side,
      viewport: ctx.viewport,
      status: validation.status,
      durationMs: Date.now() - t6,
      url: page.url(),
      screenshotPath: sp6,
      screenshotBeforePath: spBefore6,
      beforeUrl: beforeUrl6,
      actionDescription: fullActionDesc,
      selectorKey: "buyButton",
      usedSelector: buyHit.selector,
      recoveredByLlm: buyRecovered || undefined,
      note: validation.status === "ok" ? undefined : validation.note,
      detail: {
        signal: validation.signal,
        errorText: validation.errorText,
        variantRetry: variantRetryNote,
      },
    });
    reportEnd(
      6,
      "add-to-cart",
      validation.status,
      Date.now() - t6,
      validation.status === "ok" ? undefined : validation.note,
    );
    // If add-to-cart silently failed, downstream steps will be meaningless;
    // bail early so we don't report cascading "minicart not found" noise.
    if (validation.status === "failed") {
      return { pages, steps };
    }

    // Step 7: open minicart — multi-strategy (click / hover / tap / goto
    // fallback) + cart-content validation against the product title we
    // captured at step 3.
    reportStart(7, "open-minicart");
    const t7 = Date.now();
    const beforeUrl7 = page.url();
    const spBefore7 = screenshotPath(ctx, "pj-7-minicart-before");
    await screenshotStable(page, { path: spBefore7, fullPage: false });
    let miniHit = await firstVisibleLocator(page, selFor(ctx, "minicartTrigger"));
    let miniRecovered = false;
    if (!miniHit && budget.remaining > 0) {
      const recovery = await attemptRecovery(
        page,
        ctx,
        "open-minicart",
        "Abrir o minicart/drawer do carrinho",
        selFor(ctx, "minicartTrigger"),
      );
      if (recovery) {
        miniHit = recovery;
        miniRecovered = true;
        budget.remaining--;
      }
    }
    let cartOpenMethod: NonNullable<StepCapture["cartOpenMethod"]> = "failed";
    let miniText = "";
    let cartRevealMode: NonNullable<StepCapture["cartRevealMode"]> = "unknown";
    // Probe whether the drawer was ALREADY opened by add-to-cart (e.g. miess
    // prod opens an inline notification on add-to-cart with no further
    // trigger click needed). Used by detectCartRevealMode below as the
    // first signal in its classification ladder.
    const drawerAlreadyOpen = (await isCartRevealed(page, expectedProductTitle)) !== null;
    if (miniHit) {
      miniText = await miniHit.locator.innerText().catch(() => "");
      // Classify markup intent BEFORE we interact. Safe to run even when
      // drawer is already open (returns "inline-notification" first).
      cartRevealMode = await detectCartRevealMode(
        page,
        miniHit.locator,
        drawerAlreadyOpen,
        ctx.viewport,
      ).catch(() => "unknown" as const);
      dlog(ctx, `step 7 open-minicart: cartRevealMode=${cartRevealMode}`);
      const openResult = await openMinicart(page, miniHit, ctx, expectedProductTitle);
      cartOpenMethod = openResult.method;
    } else {
      // No trigger needed — drawer may already be open from add-to-cart.
      if (drawerAlreadyOpen) {
        cartOpenMethod = "already-open";
        cartRevealMode = "inline-notification";
        dlog(ctx, "step 7 open-minicart: no trigger, drawer already visible");
      }
    }
    // Validate the product from step 3 is now visible in the cart UI.
    let step7Validation: StepCapture["cartValidation"];
    if (expectedProductTitle && cartOpenMethod !== "failed") {
      const v = await validateCartContainsTitle(page, expectedProductTitle, ctx);
      let reasonText: string | undefined;
      if (!v.found) {
        if (v.observedTitles.length === 0) {
          const emptyBanner = await detectEmptyCartBanner(page);
          reasonText = emptyBanner
            ? `cart genuinely empty — add-to-cart didn't persist. Banner: "${emptyBanner}"`
            : "no cart line items visible (selectors may not match markup)";
        } else {
          reasonText = `expected title not found among ${v.observedTitles.length} observed`;
        }
      }
      step7Validation = {
        expectedTitle: expectedProductTitle,
        found: v.found,
        method: v.method,
        observedTitles: v.observedTitles.slice(0, 8),
        reason: reasonText,
      };
      dlog(
        ctx,
        `step 7 open-minicart: validation → found=${v.found} (${v.method})${reasonText ? ` — ${reasonText.slice(0, 80)}` : ""}`,
      );
    }
    const sp7 = screenshotPath(ctx, "pj-7-minicart");
    await screenshotStable(page, { path: sp7, fullPage: false });
    // #12 — prod-side cart-empty quirk. We mark step 7 (and the downstream
    // cart-dependent steps 8 + 9) as `skipped` instead of `failed` ONLY
    // when --accept-prod-quirks is set AND this is the prod side AND the
    // diagnosis is "cart genuinely empty". The further restriction
    // (cartRevealMode symmetry between prod and cand) is enforced by the
    // dedicated check `cart-reveal-mode-divergence`, which emits a
    // critical issue whenever modes diverge — so even with the skip, a
    // markup regression never silently passes.
    const cartEmptyReason = step7Validation?.reason ?? "";
    const isProdCartEmptyQuirk =
      ctx.acceptProdQuirks === true &&
      ctx.side === "prod" &&
      step7Validation !== undefined &&
      !step7Validation.found &&
      cartEmptyReason.startsWith("cart genuinely empty");
    const step7Status: StepCapture["status"] = isProdCartEmptyQuirk
      ? "skipped"
      : cartOpenMethod === "failed"
        ? "failed"
        : step7Validation && !step7Validation.found
          ? "failed"
          : "ok";
    const step7QuirkNote = isProdCartEmptyQuirk
      ? "cart-empty-prod-quirk: aceito via --accept-prod-quirks (cartRevealMode validated by separate check)"
      : undefined;
    steps.push({
      step: 7,
      name: "open-minicart",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step7Status,
      durationMs: Date.now() - t7,
      url: page.url(),
      screenshotPath: sp7,
      screenshotBeforePath: spBefore7,
      beforeUrl: beforeUrl7,
      cartOpenMethod,
      cartRevealMode,
      cartValidation: step7Validation,
      note: step7QuirkNote,
      actionDescription: miniHit
        ? `Abriu minicart via ${cartOpenMethod}${miniText ? ` em '${miniText.slice(0, 30).trim()}'` : ""} (\`${miniHit.selector}\`)${miniRecovered ? " — selector via recovery LLM" : ""}${
            step7Validation
              ? step7Validation.found
                ? " ✓ produto encontrado no cart"
                : ` ✗ produto ESPERADO não encontrado (${step7Validation.observedTitles?.length ?? 0} itens observados)`
              : ""
          }`
        : cartOpenMethod === "already-open"
          ? "Minicart já estava aberto após add-to-cart"
          : "Minicart não pôde ser aberto",
      selectorKey: miniHit ? "minicartTrigger" : undefined,
      usedSelector: miniHit?.selector,
      recoveredByLlm: miniRecovered || undefined,
    });
    reportEnd(7, "open-minicart", step7Status, Date.now() - t7, step7QuirkNote);

    // #12 — when prod hit the cart-empty quirk and we accepted it,
    // steps 8 and 9 can't be exercised on prod. Skip them with a matching
    // note so the journey ends `skipped/skipped/skipped` on prod side
    // instead of producing a misleading `failed`. The check
    // `cart-reveal-mode-divergence` is independent and still runs.
    if (isProdCartEmptyQuirk) {
      const quirkNote = "cart-empty-prod-quirk: skipped (depende do cart que prod não persistiu)";
      reportStart(8, "shipping-calc-cart");
      steps.push(makeSkipStep(8, "shipping-calc-cart", ctx, quirkNote));
      reportEnd(8, "shipping-calc-cart", "skipped", 0, quirkNote);
      reportStart(9, "go-checkout");
      steps.push(makeSkipStep(9, "go-checkout", ctx, quirkNote));
      reportEnd(9, "go-checkout", "skipped", 0, quirkNote);
      return { pages, steps };
    }

    // Step 8: shipping calc in cart
    reportStart(8, "shipping-calc-cart");
    let cepInputCart = await firstVisible(page, selFor(ctx, "cepInputCart"));
    let cepCartRecoveredByLlm = false;
    if (!cepInputCart && budget.remaining > 0) {
      const html = await page.content().catch(() => "");
      if (html) {
        const suggestion = await suggestRecovery({
          stepName: "shipping-calc-cart",
          intendedAction:
            "Encontre o <input> de CEP (código postal de ENDEREÇO de entrega) dentro do minicart drawer ou da página de carrinho — usado pra CALCULAR FRETE antes do checkout. Placeholder normalmente é 'CEP', 'Digite seu CEP', 'Cód. postal', 'Postal code', aria-label='CEP' ou name='zip'/'cep'/'postal'. **NÃO** retorne o input de CUPOM de desconto / 'Digite o cupom' / código promocional — esses são pra desconto, não pra frete. Também NÃO retorne campo de e-mail/newsletter.",
          html,
          alreadyTried: selFor(ctx, "cepInputCart"),
        });
        if (suggestion) {
          budget.remaining--;
          const el = page.locator(suggestion.selector).first();
          if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
            cepInputCart = suggestion.selector;
            cepCartRecoveredByLlm = true;
          }
        }
      }
    }
    if (cepInputCart) {
      const t8 = Date.now();
      const beforeUrl8 = page.url();
      const spBefore8 = screenshotPath(ctx, "pj-8-shipping-cart-before");
      await screenshotStable(page, { path: spBefore8, fullPage: false });
      const ok = await fillCep(page, cepInputCart, ctx.rc.cep);
      const sp8 = screenshotPath(ctx, "pj-8-shipping-cart");
      await screenshotStable(page, { path: sp8, fullPage: false });
      const step8Status: StepCapture["status"] = ok ? "ok" : "failed";
      steps.push({
        step: 8,
        name: "shipping-calc-cart",
        side: ctx.side,
        viewport: ctx.viewport,
        status: step8Status,
        durationMs: Date.now() - t8,
        url: page.url(),
        screenshotPath: sp8,
        screenshotBeforePath: spBefore8,
        beforeUrl: beforeUrl8,
        actionDescription: `Preencheu CEP '${ctx.rc.cep}' no carrinho (\`${cepInputCart}\`)${cepCartRecoveredByLlm ? " — recovery LLM" : ""}`,
        detail: { cepUsed: ctx.rc.cep },
        selectorKey: "cepInputCart",
        usedSelector: cepInputCart,
        recoveredByLlm: cepCartRecoveredByLlm || undefined,
      });
      reportEnd(8, "shipping-calc-cart", step8Status, Date.now() - t8);
    } else {
      steps.push(
        makeSkipStep(8, "shipping-calc-cart", ctx, "no CEP input in cart (recovery exhausted)"),
      );
      reportEnd(8, "shipping-calc-cart", "skipped", 0, "no CEP input in cart");
    }

    // Step 9: go to checkout
    reportStart(9, "go-checkout");
    const t9 = Date.now();
    const beforeUrl9 = page.url();
    // Early exit: some stores wire the minicart trigger as a direct link to
    // /checkout, so by the time we arrive here the user is already on the
    // checkout page. Trust the URL and validate the product is still in
    // the order summary.
    if (/\/(checkout|carrinho)(\/|$|\?)/i.test(beforeUrl9)) {
      await waitForCartHydration(page);
      let step9EarlyValidation: StepCapture["cartValidation"];
      if (expectedProductTitle) {
        const v = await validateCartContainsTitle(page, expectedProductTitle, ctx);
        step9EarlyValidation = {
          expectedTitle: expectedProductTitle,
          found: v.found,
          method: v.method,
          observedTitles: v.observedTitles.slice(0, 8),
          reason: v.found
            ? undefined
            : `expected title not found among ${v.observedTitles.length} observed on checkout`,
        };
      }
      const sp9early = screenshotPath(ctx, "pj-9-checkout-reached");
      await screenshotStable(page, { path: sp9early, fullPage: false });
      const earlyStatus: StepCapture["status"] =
        step9EarlyValidation && !step9EarlyValidation.found ? "failed" : "ok";
      steps.push({
        step: 9,
        name: "go-checkout",
        side: ctx.side,
        viewport: ctx.viewport,
        status: earlyStatus,
        durationMs: Date.now() - t9,
        url: page.url(),
        screenshotPath: sp9early,
        cartValidation: step9EarlyValidation,
        actionDescription: `Já estava em \`${beforeUrl9}\` (minicart navegou direto para checkout)${
          step9EarlyValidation
            ? step9EarlyValidation.found
              ? " ✓ produto persiste no checkout"
              : ` ✗ produto ESPERADO ausente (${step9EarlyValidation.observedTitles?.length ?? 0} observados)`
            : ""
        }`,
        detail: { reachedVia: "minicart-direct-link" },
      });
      reportEnd(9, "go-checkout", earlyStatus, Date.now() - t9);
      return { pages, steps };
    }
    let checkoutHit = await firstVisibleLocator(page, selFor(ctx, "checkoutButton"));
    let checkoutRecovered = false;
    if (!checkoutHit && budget.remaining > 0) {
      const recovery = await attemptRecovery(
        page,
        ctx,
        "go-checkout",
        "Clicar no botão 'Finalizar compra' / 'Ir para o checkout' / 'Finalizar'",
        selFor(ctx, "checkoutButton"),
      );
      if (recovery) {
        checkoutHit = recovery;
        checkoutRecovered = true;
        budget.remaining--;
      }
    }
    if (!checkoutHit) {
      steps.push(
        makeSkipStep(9, "go-checkout", ctx, "no checkout button found (recovery exhausted)"),
      );
      reportEnd(9, "go-checkout", "skipped", 0, "no checkout button found");
      return { pages, steps };
    }
    const spBefore9 = screenshotPath(ctx, "pj-9-checkout-before");
    await screenshotStable(page, { path: spBefore9, fullPage: false });
    // Click + URL race, with up to 2 LLM-recovery retries when the click
    // misses (selector matched a wrong button — common when discovery
    // confused the cart icon for the checkout button).
    let usedSelector = checkoutHit.selector;
    let clickedText = await checkoutHit.locator.innerText().catch(() => "");
    let reachedCheckout = false;
    let attempt = 0;
    const triedSelectors = new Set<string>([usedSelector]);
    while (attempt < 3) {
      attempt++;
      await Promise.all([
        page.waitForURL(/\/(checkout|carrinho)/i, { timeout: 10_000 }).catch(() => undefined),
        checkoutHit!.locator.click({ timeout: 5_000 }).catch(() => undefined),
      ]);
      await page.waitForTimeout(1_500);
      reachedCheckout = /\/(checkout|carrinho)(\/|$|\?)/i.test(page.url());
      if (reachedCheckout) break;
      // Click landed but didn't navigate — try LLM recovery for a different
      // selector before giving up. Some sites have a non-checkout button that
      // happens to match generic text selectors.
      if (budget.remaining <= 0) break;
      dlog(
        ctx,
        `step 9 go-checkout: click on \`${usedSelector}\` didn't navigate (attempt ${attempt}). URL still ${page.url()}. Asking LLM for another selector.`,
      );
      const triedList = Array.from(triedSelectors);
      const recovery = await attemptRecovery(
        page,
        ctx,
        "go-checkout",
        `O click anterior em \`${usedSelector}\` não navegou para /checkout (URL continua em ${page.url()}). Encontre OUTRO selector — o botão real de finalizar compra deve ser visível agora (no drawer aberto ou na página). Não retorne ${triedList.join(", ")} novamente.`,
        triedList,
      );
      if (!recovery) break;
      checkoutHit = recovery;
      checkoutRecovered = true;
      usedSelector = recovery.selector;
      triedSelectors.add(usedSelector);
      clickedText = await recovery.locator.innerText().catch(() => "");
      budget.remaining--;
    }
    // Reached checkout? Validate the product is there.
    let step9Validation: StepCapture["cartValidation"];
    if (reachedCheckout && expectedProductTitle) {
      await waitForCartHydration(page);
      const v = await validateCartContainsTitle(page, expectedProductTitle, ctx);
      step9Validation = {
        expectedTitle: expectedProductTitle,
        found: v.found,
        method: v.method,
        observedTitles: v.observedTitles.slice(0, 8),
        reason: v.found
          ? undefined
          : `expected title not found among ${v.observedTitles.length} observed on checkout`,
      };
    }
    const sp9 = screenshotPath(ctx, "pj-9-checkout-reached");
    await screenshotStable(page, { path: sp9, fullPage: false });
    const step9Status: StepCapture["status"] = !reachedCheckout
      ? "failed"
      : step9Validation && !step9Validation.found
        ? "failed"
        : "ok";
    steps.push({
      step: 9,
      name: "go-checkout",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step9Status,
      durationMs: Date.now() - t9,
      url: page.url(),
      screenshotPath: sp9,
      screenshotBeforePath: spBefore9,
      beforeUrl: beforeUrl9,
      cartValidation: step9Validation,
      actionDescription: `Clicou em${clickedText ? ` '${clickedText.slice(0, 30).trim()}'` : ""} (\`${usedSelector}\`); URL final: ${page.url()}${reachedCheckout ? " ✓ atingiu checkout" : " ✗ não foi pra checkout"}${attempt > 1 ? ` (após ${attempt} tentativas com recovery LLM)` : ""}${
        step9Validation
          ? step9Validation.found
            ? " ✓ produto persiste no checkout"
            : ` ✗ produto ESPERADO ausente no checkout (${step9Validation.observedTitles?.length ?? 0} observados)`
          : ""
      }`,
      selectorKey: "checkoutButton",
      usedSelector,
      recoveredByLlm: checkoutRecovered || undefined,
    });
    reportEnd(9, "go-checkout", step9Status, Date.now() - t9);

    return { pages, steps };
  } finally {
    await page.close();
  }
}

function makeSkipStep(step: number, name: string, ctx: FlowContext, note: string): StepCapture {
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
    await page
      .locator(selector)
      .first()
      .press("Enter")
      .catch(() => undefined);
    await page.waitForTimeout(3_000);
    return true;
  } catch {
    return false;
  }
}

interface VariantSelectionResult {
  /** Human-readable description of every action taken (joined into actionDescription). */
  actions: string[];
  /** First selector key that produced an action, for learned-selectors promotion. */
  primarySelectorKey?: string;
  /** First selector string that produced an action. */
  primarySelector?: string;
  /** True when we detected a "select-first" warning text on the page (so a skip is suspicious). */
  variantRequired: boolean;
}

/**
 * Pure heuristic: attempts size / color / variant-row / quantity-input selection
 * on the current PDP. Does NOT consume the LLM recovery budget — only baked-in
 * selectors. Returns a list of actions actually performed plus a hint about
 * whether the page is *demanding* variant selection (so the caller can decide
 * how alarmed to be about a skip).
 */
async function selectVariant(page: Page, ctx: FlowContext): Promise<VariantSelectionResult> {
  const actions: string[] = [];
  let primarySelectorKey: string | undefined;
  let primarySelector: string | undefined;

  const trackPrimary = (key: string, sel: string) => {
    if (!primarySelectorKey) {
      primarySelectorKey = key;
      primarySelector = sel;
    }
  };

  // 1) Variant rows with their own quantity controls (e.g. Miees-style COR×U tables).
  // We only touch the FIRST visible row to keep the cart deterministic.
  try {
    const rowSelectors = selFor(ctx, "variantRow");
    const incrementSelectors = selFor(ctx, "quantityIncrement");
    rowLoop: for (const rowSel of rowSelectors) {
      const rows = page.locator(rowSel);
      const count = await rows.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 5); i++) {
        const row = rows.nth(i);
        if (!(await row.isVisible({ timeout: 500 }).catch(() => false))) continue;
        const rowText = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        for (const incSel of incrementSelectors) {
          const plus = row.locator(incSel).first();
          if (!(await plus.isVisible({ timeout: 500 }).catch(() => false))) continue;
          if (await plus.isDisabled().catch(() => false)) continue;
          await plus.click({ timeout: 2_000 }).catch(() => undefined);
          await page.waitForTimeout(400);
          actions.push(
            `Incrementou quantidade da variante \`${rowSel}\`[${i}]${rowText ? ` (${rowText.slice(0, 40)})` : ""} via \`${incSel}\``,
          );
          trackPrimary("variantRow", rowSel);
          break rowLoop;
        }
      }
    }
  } catch {
    /* continue */
  }

  // 2) Size swatch — first available.
  if (actions.length === 0) {
    const sizeHit = await firstVisibleLocator(page, selFor(ctx, "sizeSwatch"));
    if (sizeHit && !(await sizeHit.locator.isDisabled().catch(() => false))) {
      const sizeText = (await sizeHit.locator.innerText().catch(() => "")).slice(0, 20).trim();
      await sizeHit.locator.click({ timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      actions.push(
        `Selecionou tamanho${sizeText ? ` '${sizeText}'` : ""} (\`${sizeHit.selector}\`)`,
      );
      trackPrimary("sizeSwatch", sizeHit.selector);
    }
  }

  // 3) Color swatch — first available (independent of size; some PDPs require both).
  const colorHit = await firstVisibleLocator(page, selFor(ctx, "colorSwatch"));
  if (colorHit && !(await colorHit.locator.isDisabled().catch(() => false))) {
    const colorText = (await colorHit.locator.innerText().catch(() => "")).slice(0, 20).trim();
    const colorLabel =
      colorText || (await colorHit.locator.getAttribute("aria-label").catch(() => null)) || "";
    await colorHit.locator.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    actions.push(
      `Selecionou cor${colorLabel ? ` '${colorLabel}'` : ""} (\`${colorHit.selector}\`)`,
    );
    trackPrimary("colorSwatch", colorHit.selector);
  }

  // 4) Quantity inputs — covers both single-SKU (one input) and "variant
  // table" layouts (N inputs, one per row, all starting at 0) used by stores
  // like Miess that render the SKU picker as a list where each row has
  // an `<input type='number' value='0'>` plus a separate `+` button.
  if (actions.length === 0) {
    await scrollPageInChunks(page);
    const result = await findAndIncrementZeroQtyInput(page, ctx);
    if (result) {
      actions.push(result.description);
      trackPrimary(result.selectorKey, result.usedSelector);
    }
  }

  let variantRequired = false;
  try {
    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 1_000 })
      .catch(() => "");
    variantRequired = VARIANT_REQUIRED_TEXT_PATTERNS.some((re) => re.test(bodyText));
  } catch {
    /* ignore */
  }

  return { actions, primarySelectorKey, primarySelector, variantRequired };
}

/**
 * Step through the page in chunks to trigger IntersectionObserver-based lazy
 * hydration (Deco f-partial, Fresh islands with `threshold` triggers, etc).
 * Variant pickers are commonly rendered this way and aren't in the DOM
 * immediately after navigation.
 */
async function scrollPageInChunks(page: Page): Promise<void> {
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

interface VariantIncrementResult {
  description: string;
  selectorKey: string;
  usedSelector: string;
}

/**
 * Search the page for a quantity input that's currently at 0/empty, then
 * click the nearest `+` button. The `+` is usually NOT a direct sibling of
 * the input (Miess wraps each in its own flex container) so we walk the
 * input's ancestry to find a wrapping row that also contains the `+`.
 */
async function findAndIncrementZeroQtyInput(
  page: Page,
  ctx: FlowContext,
): Promise<VariantIncrementResult | null> {
  const qtySelectors = selFor(ctx, "quantityInput");

  // Try inside the main product section first to avoid related-product carousels.
  const scopeSelectors = [
    "[data-manifest-key*='ProductDetails' i]",
    "[data-manifest-key*='Product/' i]",
    "main",
  ];
  const scopeRoots: Array<{ root: Locator | null; tag: "main" | "page" }> = [];
  for (const sel of scopeSelectors) {
    const cand = page.locator(sel).first();
    if (
      await cand
        .count()
        .then((n) => n > 0)
        .catch(() => false)
    ) {
      scopeRoots.push({ root: cand, tag: "main" });
      break;
    }
  }
  scopeRoots.push({ root: null, tag: "page" });

  for (const { root, tag } of scopeRoots) {
    for (const sel of qtySelectors) {
      const all = root ? root.locator(sel) : page.locator(sel);
      const count = await all.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 20); i++) {
        const el = all.nth(i);
        if (!(await el.isVisible({ timeout: 300 }).catch(() => false))) continue;
        const value = (await el.inputValue().catch(() => "")).trim();
        // Strict: only act on 0/empty inputs. A qty=1 input is either
        // a carousel card (wrong target) or a single-SKU already valid.
        if (value !== "" && value !== "0") continue;

        const plus = await findPlusButtonNear(el);
        if (plus) {
          if (await plus.isDisabled().catch(() => false)) continue;
          await plus.click({ timeout: 2_000 }).catch(() => undefined);
          await page.waitForTimeout(500);
          // Record the INPUT selector (which IS a reusable CSS selector)
          // rather than the composite walk. Next run can find the input
          // again via this learned hint, and the heuristic re-locates
          // the '+' button relative to it.
          return {
            description: `Incrementou variante via botão '+' próximo ao input \`${sel}\` (scope=${tag}, índice ${i})`,
            selectorKey: "quantityInput",
            usedSelector: sel,
          };
        }
        // Fallback: type "1" directly into the input.
        await el.fill("1", { timeout: 1_500 }).catch(() => undefined);
        await el.dispatchEvent("input").catch(() => undefined);
        await el.dispatchEvent("change").catch(() => undefined);
        await page.waitForTimeout(400);
        return {
          description: `Ajustou quantidade do input \`${sel}\` para 1 (scope=${tag}, índice ${i})`,
          selectorKey: "quantityInput",
          usedSelector: sel,
        };
      }
    }
  }
  return null;
}

/**
 * Walk the input's ancestry looking for the closest container that ALSO
 * holds a button whose text is `+`. Handles the Miess layout where the `+`
 * is nested in a sibling div, not a direct sibling of the input.
 */
async function findPlusButtonNear(input: Locator): Promise<Locator | null> {
  // First try: closest ancestor li / tr / form / fieldset / data-row that
  // contains a + button. Walk up to 6 levels.
  const ancestorXPath =
    "xpath=ancestor::*[self::li or self::tr or self::form or self::fieldset or @data-sku-row or @data-variant-row][1]//button[normalize-space(.)='+']";
  const inAncestor = input.locator(ancestorXPath).first();
  if (await inAncestor.isVisible({ timeout: 600 }).catch(() => false)) {
    return inAncestor;
  }
  // Second try: walk N levels up looking for a + button. Stops at the first
  // ancestor that contains one.
  for (let depth = 1; depth <= 6; depth++) {
    const climb = `xpath=ancestor::*[${depth}]//button[normalize-space(.)='+']`;
    const cand = input.locator(climb).first();
    if (await cand.isVisible({ timeout: 300 }).catch(() => false)) {
      return cand;
    }
  }
  // Third try: immediate following-sibling (legacy / simple layouts).
  const sibling = input.locator("xpath=following-sibling::button[1]").first();
  if (await sibling.isVisible({ timeout: 300 }).catch(() => false)) {
    const text = (await sibling.innerText().catch(() => "")).trim();
    if (text === "+") return sibling;
  }
  return null;
}

async function readCartCount(page: Page, ctx: FlowContext): Promise<number> {
  const selectors = selFor(ctx, "minicartCount");
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const raw = (await el.innerText().catch(() => "")).trim();
      const match = raw.match(/\d+/);
      if (match) return Number.parseInt(match[0], 10);
    } catch {
      /* try next */
    }
  }
  return 0;
}

interface AddToCartValidation {
  status: StepCapture["status"];
  signal:
    | "count-increased"
    | "drawer-open"
    | "url-changed"
    | "success-toast"
    | "no-signal"
    | "error-text";
  note: string;
  errorText?: string;
}

/**
 * After clicking the buy button, decide whether the cart actually received the
 * item. We poll for up to ~3s looking for ANY positive signal; in parallel we
 * sniff for error text that indicates the store rejected the click (missing
 * variant, out of stock, etc). Only "ok" if a positive signal materialized
 * without an accompanying error.
 */
async function validateAddToCart(
  page: Page,
  ctx: FlowContext,
  cartCountBefore: number,
  beforeUrl: string,
): Promise<AddToCartValidation> {
  const deadline = Date.now() + 3_000;
  let lastErrorText: string | undefined;

  while (Date.now() < deadline) {
    // URL change to cart/checkout is a strong positive.
    const currentUrl = page.url();
    if (currentUrl !== beforeUrl && /\/(cart|carrinho|checkout)(\/|$|\?)/i.test(currentUrl)) {
      return {
        status: "ok",
        signal: "url-changed",
        note: `URL mudou para \`${currentUrl}\` (carrinho/checkout)`,
      };
    }

    // Cart count badge increased.
    const cartCountNow = await readCartCount(page, ctx);
    if (cartCountNow > cartCountBefore) {
      return {
        status: "ok",
        signal: "count-increased",
        note: `Contador do minicart foi de ${cartCountBefore} para ${cartCountNow}`,
      };
    }

    // A dialog/drawer that wasn't visible before became visible.
    const drawerSelectors = [
      "[role='dialog']",
      "[data-minicart][aria-expanded='true']",
      "[data-cart-drawer].open",
      "[data-minicart-drawer]:not([hidden])",
      ".minicart--open",
      ".cart-drawer--open",
    ];
    for (const sel of drawerSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 200 }).catch(() => false)) {
        return {
          status: "ok",
          signal: "drawer-open",
          note: `Drawer/modal do carrinho abriu (\`${sel}\`)`,
        };
      }
    }

    // Body text scan — used for both positive (success toast) and negative
    // (variant required, out of stock) signals. Success wins because some
    // stores show a "PRODUTO ADICIONADO!" toast on the same page where
    // unrelated "out of stock" or "selecione" copy already exists in
    // descriptions/related products.
    try {
      const bodyText = await page
        .locator("body")
        .innerText({ timeout: 500 })
        .catch(() => "");
      for (const re of ADD_TO_CART_SUCCESS_PATTERNS) {
        const match = bodyText.match(re);
        if (match) {
          return {
            status: "ok",
            signal: "success-toast",
            note: `Toast de sucesso visível: '${match[0]}'`,
          };
        }
      }
      for (const re of ADD_TO_CART_ERROR_PATTERNS) {
        const match = bodyText.match(re);
        if (match) {
          lastErrorText = match[0];
          break;
        }
      }
    } catch {
      /* ignore */
    }

    await page.waitForTimeout(250);
  }

  if (lastErrorText) {
    return {
      status: "failed",
      signal: "error-text",
      note: `add-to-cart silenciosamente falhou: '${lastErrorText}' visível na página`,
      errorText: lastErrorText,
    };
  }
  return {
    status: "failed",
    signal: "no-signal",
    note: "add-to-cart sem confirmação visível (minicart não atualizou, sem drawer, sem mudança de URL)",
  };
}

/**
 * Ask the LLM to recover from a failed selector lookup. Returns a usable
 * locator + the suggested selector string, or null if the recovery failed.
 */
/**
 * Universal "find this element" helper.
 *
 * Cascade:
 *   1. If `key` is set, try the SelectorKey cascade (override → learned → defaults).
 *   2. If `extraSelectors` is set, try those next.
 *   3. If `budget.remaining > 0`, ask the LLM to find an element matching `intent`.
 *
 * Returns `{ locator, selector, recoveredByLlm }` on first match, `null` otherwise.
 * Mutates `budget.remaining` (decrements) only when the LLM recovery succeeds —
 * matches the existing `attemptRecovery` calling convention.
 *
 * Usage:
 *   const hit = await findElement(page, ctx, {
 *     key: "searchInput",
 *     intent: "Input <input> de busca onde o usuário digita o termo (não confundir com email/CEP).",
 *     budget,
 *   });
 *   if (hit) await hit.locator.click();
 */
export async function findElement(
  page: Page,
  ctx: FlowContext,
  opts: {
    /** Optional selector key — when set, runs the override→learned→defaults cascade first. */
    key?: SelectorKey;
    /** Description of what we want, in PT-BR (used as the LLM recovery prompt). */
    intent: string;
    /** Optional explicit selectors to try AFTER the key's cascade. */
    extraSelectors?: string[];
    /** Shared LLM-recovery budget for the parent flow. Decremented on successful recovery. */
    budget: { remaining: number };
    /** Optional name surfaced in trace logs. Defaults to "find-element". */
    stepName?: string;
  },
): Promise<{ locator: Locator; selector: string; recoveredByLlm: boolean } | null> {
  const tried: string[] = [];

  if (opts.key) {
    const cascade = selFor(ctx, opts.key);
    tried.push(...cascade);
    const hit = await firstVisibleLocator(page, cascade);
    if (hit) return { ...hit, recoveredByLlm: false };
  }

  if (opts.extraSelectors && opts.extraSelectors.length > 0) {
    tried.push(...opts.extraSelectors);
    const hit = await firstVisibleLocator(page, opts.extraSelectors);
    if (hit) return { ...hit, recoveredByLlm: false };
  }

  if (opts.budget.remaining > 0) {
    const recovered = await attemptRecovery(
      page,
      ctx,
      opts.stepName ?? "find-element",
      opts.intent,
      tried,
    );
    if (recovered) {
      opts.budget.remaining--;
      return { ...recovered, recoveredByLlm: true };
    }
  }
  return null;
}

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

export interface StepActionResult {
  /** True if some action was actually performed (click/fill/press). */
  performed: boolean;
  /** Selector string that worked (CSS or Playwright). Empty if nothing matched. */
  selector: string;
  /** Action actually executed. */
  action: "click" | "fill" | "press";
  /** Whether the selector came from LLM recovery (so the caller can promote). */
  recoveredByLlm: boolean;
}

/**
 * Generic per-step action driver: tries the baked-in/learned selectors first,
 * then calls the LLM as a fallback when nothing matched (budget permitting),
 * and performs the requested action (click | fill | press) so the caller
 * doesn't have to. Returns what was done + the selector used so the
 * promotion loop can persist it across runs.
 *
 * Use this for ANY step where a missing element should trigger an LLM
 * recovery attempt — the user explicitly wants every failing step retried.
 */
async function attemptStepAction(args: {
  page: Page;
  ctx: FlowContext;
  stepName: string;
  intendedAction: string;
  selectorKey: SelectorKey;
  action: "click" | "fill" | "press";
  /** Value to fill (for "fill") or key to press (for "press"). */
  value?: string;
  /** Mutable counter — decremented when LLM is invoked. */
  recoveryBudget: { remaining: number };
}): Promise<StepActionResult> {
  const { page, ctx, stepName, intendedAction, selectorKey, action, value, recoveryBudget } = args;
  const selectors = selFor(ctx, selectorKey);

  // Phase 1: try the baked-in/learned cascade.
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (!(await el.isVisible({ timeout: 800 }).catch(() => false))) continue;
      const ok = await performAction(el, action, value);
      if (ok) {
        return { performed: true, selector: sel, action, recoveredByLlm: false };
      }
    } catch {
      /* try next */
    }
  }

  // Phase 2: LLM fallback (budget-gated).
  if (recoveryBudget.remaining <= 0) {
    return { performed: false, selector: "", action, recoveredByLlm: false };
  }
  let html = "";
  try {
    html = await page.content();
  } catch {
    return { performed: false, selector: "", action, recoveredByLlm: false };
  }
  const suggestion = await suggestRecovery({
    stepName,
    intendedAction,
    html,
    alreadyTried: selectors,
  });
  if (!suggestion) {
    return { performed: false, selector: "", action, recoveredByLlm: false };
  }
  recoveryBudget.remaining--;
  // The LLM is allowed to override the requested action (e.g. it may decide
  // "fill" makes more sense than "click" given the markup). Trust it within
  // the bounds of what performAction supports.
  const llmAction = suggestion.action ?? action;
  const llmValue = suggestion.value ?? value;
  try {
    const el = page.locator(suggestion.selector).first();
    if (!(await el.isVisible({ timeout: 2_000 }).catch(() => false))) {
      return { performed: false, selector: "", action: llmAction, recoveredByLlm: false };
    }
    const ok = await performAction(el, llmAction, llmValue);
    if (ok) {
      return {
        performed: true,
        selector: suggestion.selector,
        action: llmAction,
        recoveredByLlm: true,
      };
    }
  } catch {
    /* invalid selector or runtime error */
  }
  return { performed: false, selector: "", action: llmAction, recoveredByLlm: false };
}

async function performAction(
  el: Locator,
  action: "click" | "fill" | "press",
  value: string | undefined,
): Promise<boolean> {
  try {
    if (action === "click") {
      await el.click({ timeout: 3_000 });
      return true;
    }
    if (action === "fill") {
      await el.fill(value ?? "", { timeout: 3_000 });
      // Some controls only react to keyboard "Enter" (zip-code triggers).
      await el.press("Enter", { timeout: 1_500 }).catch(() => undefined);
      return true;
    }
    if (action === "press") {
      await el.press(value ?? "Enter", { timeout: 1_500 });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Product title extraction + cart validation
//
// Ported from upstream (PR #10) so this branch keeps the "did the right
// product end up in the cart?" assertion. Without it the cart steps
// only check that a cart UI opened, which lets a broken add-to-cart
// (wrong SKU added, session not persisted, etc) slip through silently.
// ─────────────────────────────────────────────────────────────────────

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

async function extractProductTitle(page: Page): Promise<string | null> {
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
      const visible = await withCap(
        el.isVisible({ timeout: 250 }).catch(() => false),
        400,
        false,
      );
      if (!visible) continue;
      const text = await withCap(
        el.innerText().catch(() => ""),
        500,
        "",
      );
      const clean = text.trim();
      if (clean.length > 3 && !looksGeneric(clean)) return clean;
    } catch {
      /* try next */
    }
  }
  // JSON-LD Product.name fallback.
  try {
    const jsonLdName = await withCap(
      page.evaluate(() => {
        const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
        for (const s of scripts) {
          try {
            const data = JSON.parse((s as HTMLScriptElement).textContent ?? "{}");
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
              const product =
                item?.["@graph"]?.find?.((x: { "@type"?: string }) => x?.["@type"] === "Product") ??
                item;
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
  try {
    const og = await withCap(
      page
        .locator("meta[property='og:title']")
        .first()
        .getAttribute("content")
        .catch(() => null),
      500,
      null,
    );
    if (og && og.trim().length > 3 && !looksGeneric(og)) return og.trim();
  } catch {
    /* fall through */
  }
  const docTitle = await withCap(
    page.title().catch(() => ""),
    500,
    "",
  );
  if (docTitle.trim().length > 3 && !looksGeneric(docTitle)) return docTitle.trim();
  return null;
}

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
 * Classify the minicart trigger by inspecting its markup (issue #12).
 *
 * Returns the INTENT of the trigger, not which strategy our harness will
 * use. Compare prod.cartRevealMode against cand.cartRevealMode to surface
 * markup divergence (e.g. cand turned a hover-drawer trigger into a
 * click-navigate link — a real UX regression, not a quirk).
 *
 * The classification ladder, evaluated in order:
 *
 *  1. drawerAlreadyOpen → "inline-notification"
 *     If add-to-cart already revealed the cart (validateAddToCart caught
 *     a drawer/toast), the trigger is dormant — the markup intent is
 *     "open inline on add-to-cart".
 *
 *  2. `<a href="/checkout..." | "/cart...">` → "click-navigate-checkout|cart"
 *     Trigger is a link that navigates. We can SEE this from the DOM
 *     without interacting.
 *
 *  3. `[onclick]` attribute or known click-binding markers → "click-drawer"
 *     Trigger has a click handler. We attempt to observe hover-vs-click
 *     behaviour to disambiguate from hover-drawer.
 *
 *  4. Hover dry-run (desktop only): hover and watch for DOM mutation
 *     within 600ms. If we see a new dialog/drawer appear → "hover-drawer".
 *
 *  5. Fallback → "unknown".
 *
 * IMPORTANT: this function MUST be side-effect-free w.r.t. cart state.
 * We do NOT click. We may hover briefly (desktop) but immediately move
 * the mouse away so the hover state doesn't leak into the rest of the
 * step's screenshot.
 */
async function detectCartRevealMode(
  page: Page,
  trigger: Locator,
  drawerAlreadyOpen: boolean,
  viewport: Viewport,
): Promise<NonNullable<StepCapture["cartRevealMode"]>> {
  if (drawerAlreadyOpen) return "inline-notification";

  // 2. Link inspection — works for both viewports, no interaction needed.
  try {
    const href = (await trigger.getAttribute("href").catch(() => null)) ?? "";
    const lower = href.toLowerCase();
    if (/\/checkout(\b|\/|\?|#)/i.test(lower)) return "click-navigate-checkout";
    if (/\/cart(\b|\/|\?|#)/i.test(lower) || /\/carrinho(\b|\/|\?|#)/i.test(lower)) {
      return "click-navigate-cart";
    }
  } catch {
    /* trigger may have detached */
  }

  // 3. Onclick / click-binding attribute markers.
  let hasClickAttr = false;
  try {
    const onclick = await trigger.getAttribute("onclick").catch(() => null);
    if (onclick && onclick.trim().length > 0) hasClickAttr = true;
  } catch {
    /* ignore */
  }

  // 4. Hover dry-run — only on desktop where pointer hover is meaningful.
  //    Watch for new role=dialog / minicart-class element added in ~600ms.
  if (viewport === "desktop") {
    try {
      const observedHoverDrawer = await page.evaluate(async () => {
        return await new Promise<boolean>((resolve) => {
          const selectorMatch = (el: Element): boolean => {
            if (!(el instanceof HTMLElement)) return false;
            if (el.getAttribute("role") === "dialog") return true;
            const cls = `${el.className || ""}`;
            return /minicart|drawer|cart-popup|cart-modal/i.test(cls);
          };
          const observer = new MutationObserver((muts) => {
            for (const m of muts) {
              for (const n of Array.from(m.addedNodes)) {
                if (n instanceof Element && selectorMatch(n)) {
                  observer.disconnect();
                  resolve(true);
                  return;
                }
              }
              if (
                m.type === "attributes" &&
                m.target instanceof Element &&
                selectorMatch(m.target)
              ) {
                observer.disconnect();
                resolve(true);
                return;
              }
            }
          });
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style", "aria-expanded", "open"],
          });
          setTimeout(() => {
            observer.disconnect();
            resolve(false);
          }, 600);
        });
      });
      // Trigger the hover that the observer above is listening for.
      const hoverPromise = trigger.hover({ timeout: 1_500 }).catch(() => undefined);
      await hoverPromise;
      const result = await observedHoverDrawer;
      // Move the mouse away to clear any hover state we left behind.
      await page.mouse.move(0, 0).catch(() => undefined);
      if (result) return "hover-drawer";
    } catch {
      /* fall through */
    }
  }

  if (hasClickAttr) return "click-drawer";
  return "unknown";
}

async function isCartRevealed(
  page: Page,
  expectedProductTitle: string | null,
): Promise<string | null> {
  if (expectedProductTitle) {
    const v = await validateCartContainsTitleQuick(page, expectedProductTitle);
    if (v) return `title-found:${v}`;
  }
  return isCartUiVisible(page);
}

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
      const text = await withCap(
        scopeLoc
          .first()
          .innerText()
          .catch(() => ""),
        800,
        "",
      );
      if (text && titlesMatch(text, expectedTitle)) return scope;
    } catch {
      /* try next */
    }
  }
  return null;
}

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
      if (
        !(await withCap(
          overlay.isVisible({ timeout: 200 }).catch(() => false),
          400,
          false,
        ))
      )
        continue;
      const closer = overlay
        .locator(
          "button[aria-label*='close' i], button[aria-label*='fechar' i], button[class*='close' i], [data-close], [aria-label='Close']",
        )
        .first();
      if (
        await withCap(
          closer.isVisible({ timeout: 200 }).catch(() => false),
          400,
          false,
        )
      ) {
        await closer.click({ timeout: 1_500 }).catch(() => undefined);
        dismissedAny = true;
        continue;
      }
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

async function waitForCartHydration(page: Page): Promise<void> {
  await Promise.race([
    page
      .waitForResponse(
        (r) => /\/api\/checkout\/pub\/orderForm|orderForm|cart\/api/i.test(r.url()) && r.ok(),
        { timeout: 8_000 },
      )
      .catch(() => undefined),
    page
      .waitForSelector(".cart-items, [class*='cart-item' i], #cart-fixed .item, [data-cart-item]", {
        timeout: 8_000,
      })
      .catch(() => undefined),
  ]);
  await page.waitForTimeout(800);
}

async function openMinicart(
  page: Page,
  trigger: { locator: Locator; selector: string },
  ctx: FlowContext,
  expectedProductTitle: string | null,
): Promise<{
  method: NonNullable<StepCapture["cartOpenMethod"]>;
  url: string;
  visibleMarker: string | null;
}> {
  const beforeUrl = page.url();
  await dismissOverlays(page, ctx);
  await page.waitForTimeout(800);
  const alreadyOpen = await isCartRevealed(page, expectedProductTitle);
  if (alreadyOpen) {
    dlog(ctx, `  openMinicart: already-open (matched ${alreadyOpen})`);
    return { method: "already-open", url: beforeUrl, visibleMarker: alreadyOpen };
  }
  const triggerHref = await trigger.locator.getAttribute("href").catch(() => null);
  const hrefHasCartTarget = !!triggerHref && /\/(checkout|cart|carrinho)/i.test(triggerHref);

  // Strategy 1: hover FIRST on desktop (Miess prod opens drawer on hover).
  if (ctx.viewport === "desktop") {
    dlog(
      ctx,
      `  openMinicart: trying hover first on ${trigger.selector}${triggerHref ? ` (href=${triggerHref})` : ""}`,
    );
    await trigger.locator.hover({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    const hoverOpened = await isCartRevealed(page, expectedProductTitle);
    if (hoverOpened) {
      dlog(ctx, `  openMinicart: hover opened drawer (${hoverOpened})`);
      return { method: "hover", url: page.url(), visibleMarker: hoverOpened };
    }
  }

  // Strategy 2a (mobile): real tap.
  if (ctx.viewport === "mobile") {
    dlog(ctx, `  openMinicart: trying tap (mobile) on ${trigger.selector}`);
    await Promise.all([
      page
        .waitForURL((url) => url.toString() !== beforeUrl, { timeout: 4_000 })
        .catch(() => undefined),
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

  // Strategy 2b: force click + URL race.
  dlog(
    ctx,
    `  openMinicart: trying force-click on ${trigger.selector}${triggerHref ? ` (href=${triggerHref})` : ""}`,
  );
  await Promise.all([
    page
      .waitForURL((url) => url.toString() !== beforeUrl, { timeout: 4_000 })
      .catch(() => undefined),
    trigger.locator.click({ force: true, timeout: 4_000 }).catch(() => undefined),
  ]);
  const afterClickUrl = page.url();
  if (afterClickUrl !== beforeUrl) {
    await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => undefined);
    await waitForCartHydration(page);
    dlog(ctx, `  openMinicart: click navigated → ${page.url()} (settled)`);
    return { method: "click-navigate", url: page.url(), visibleMarker: null };
  }
  await page.waitForTimeout(1_500);
  const clickOpened = await isCartRevealed(page, expectedProductTitle);
  if (clickOpened) {
    dlog(ctx, `  openMinicart: click opened drawer (${clickOpened})`);
    return { method: "click", url: afterClickUrl, visibleMarker: clickOpened };
  }
  // Strategy 3 (mobile only): hover as fallback.
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
  // Strategy 4: direct goto fallback when trigger has cart href.
  if (hrefHasCartTarget && triggerHref) {
    const targetUrl = (() => {
      try {
        return new URL(triggerHref, page.url()).toString();
      } catch {
        return null;
      }
    })();
    if (targetUrl) {
      dlog(
        ctx,
        `  openMinicart: all interactive strategies failed; navigating directly to ${targetUrl}`,
      );
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
  if (e.length >= 12 && o.includes(e)) return true;
  if (o.length >= 12 && e.includes(o)) return true;
  return false;
}

async function validateCartContainsTitle(
  page: Page,
  expectedTitle: string,
  ctx: FlowContext,
): Promise<{ found: boolean; observedTitles: string[]; method: "selector" | "none" }> {
  const titleSelectors = [
    "[data-cart-item-name]",
    "[data-cart-item] [class*='title' i]",
    "[data-cart-item] [class*='name' i]",
    "[class*='cart' i] [data-product-name]",
    "[role='dialog'] [data-product-name]",
    "[class*='checkout' i] [data-product-name]",
    "[class*='minicart' i] [data-product-name]",
    "[data-testid='cart-item-name']",
    "[data-testid='product-name']",
    "[role='dialog'] li [class*='product' i]",
    "[role='dialog'] li [class*='name' i]",
    "[role='dialog'] li [class*='title' i]",
    "[role='dialog'] a[href*='/p']",
    "[class*='minicart' i] [class*='item' i] [class*='name' i]",
    "[class*='minicart' i] [class*='item' i] [class*='title' i]",
    "[class*='cart-item' i] [class*='name' i]",
    "[class*='cart-item' i] [class*='title' i]",
    "[class*='checkout' i] [class*='product' i] [class*='name' i]",
    ".vtex-minicart-2-x-itemNameContainer",
    ".vtex-checkout-summary-0-x-itemName",
    ".product-name",
    ".item-name",
    "a.product-name",
    ".cart-items .item-name",
    "tr.product-item .item-name",
    "tr.cart-item .item-name",
    "table.cart-items td a",
    "#cart-fixed .item .product-name",
    "#cart-fixed .item-name",
    ".cart-fixed .item-name",
    ".cart-fixed .product-name",
    "#cart-fixed li a",
    "#minicart-content .item-name",
    "[data-fs-cart-item-summary-title]",
    "[data-fs-cart-item-image] + * a",
    "[class*='cart' i] a[href*='/p']",
    "[class*='checkout' i] a[href*='/p']",
  ];
  const sweepTitles = async (): Promise<string[]> => {
    const observed: string[] = [];
    for (const sel of titleSelectors) {
      try {
        const loc = page.locator(sel);
        const count = await withCap(loc.count(), 1_000, 0);
        const limit = Math.min(count, 10);
        for (let i = 0; i < limit; i++) {
          const el = loc.nth(i);
          const visible = await withCap(
            el.isVisible({ timeout: 200 }).catch(() => false),
            400,
            false,
          );
          if (!visible) continue;
          const text = await withCap(
            el.innerText().catch(() => ""),
            500,
            "",
          );
          const clean = text.trim().slice(0, 200);
          if (clean.length > 2) observed.push(clean);
        }
        if (observed.length > 0) return observed;
      } catch {
        /* try next */
      }
    }
    return observed;
  };

  let observed = await sweepTitles();
  if (observed.length === 0) {
    dlog(ctx, "  validateCartContainsTitle: 0 titles on first pass, retrying after 2s");
    await page.waitForTimeout(2_000);
    observed = await sweepTitles();
  }
  dlog(ctx, `  validateCartContainsTitle: observed ${observed.length} titles`);
  if (observed.length === 0) {
    return { found: false, observedTitles: [], method: "none" };
  }
  const found = observed.some((o) => titlesMatch(o, expectedTitle));
  return { found, observedTitles: observed, method: "selector" };
}

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
      if (
        await withCap(
          loc.isVisible({ timeout: 300 }).catch(() => false),
          500,
          false,
        )
      ) {
        const text = await withCap(
          loc.innerText().catch(() => ""),
          500,
          "",
        );
        if (text.trim()) return text.trim().slice(0, 120);
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fase 2 flows — search / cart-interactions / login.
// ---------------------------------------------------------------------------

const NO_RESULTS_TEXT_PATTERNS: RegExp[] = [
  /nenhum (resultado|produto|item)/i,
  /n[aã]o encontramos/i,
  /n[aã]o foi(ram)? encontrad/i,
  /n[aã]o encontrad/i, // covers "não encontrada", "não encontrado", and the Miess "BUSCA NÃO ENCONTRADA"
  /busca n[aã]o encontrada/i,
  /sem resultados/i,
  /no results/i,
  /no products/i,
  /\bno items\b/i,
  /0 (resultado|produto|item)/i,
  /didn[’']?t find/i,
  /sorry,? we couldn[’']?t find/i,
  // VTEX Intelligent Search typical strings
  /n[aã]o encontramos resultados/i,
  /resultados? para\s+["“'].*["”']\s*[\(:]?\s*0/i,
];

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
async function countProductCards(page: Page): Promise<number> {
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

/**
 * Detect a "no results" / empty-state banner.
 *
 * Three sources of truth checked (most reliable first):
 *  1. Page innerText() — what the user actually sees on the rendered page.
 *  2. The full HTML capture passed in (more reliable when SPA hydration is
 *     slow and innerText misses a heading that's actually in the DOM).
 *  3. Proximity heuristic — if the search term appears near a negative cue
 *     ("não", "no", "0", "sem"), that's an empty-state pattern even if our
 *     hardcoded regexes don't match the exact phrasing.
 */
async function detectNoResultsEmptyState(
  page: Page,
  capturedHtml: string,
  term?: string,
): Promise<boolean> {
  const innerText = await withCap(
    page
      .locator("body")
      .innerText()
      .catch(() => ""),
    2_000,
    "",
  );

  // Pool of text to scan: rendered innerText + raw HTML (catches text
  // inserted between capture and our innerText call, or in attributes).
  const haystack = `${innerText}\n${capturedHtml}`;

  if (NO_RESULTS_TEXT_PATTERNS.some((re) => re.test(haystack))) return true;

  if (term && term.length >= 4) {
    const lowerHaystack = haystack.toLowerCase();
    const idx = lowerHaystack.indexOf(term.toLowerCase());
    if (idx >= 0) {
      const around = haystack.slice(Math.max(0, idx - 120), idx + term.length + 120);
      if (/\b(n[aã]o|nenhum|sem|\b0\b|zero|no)\b/i.test(around)) return true;
    }
  }
  return false;
}

/**
 * Build the URL the site uses for `?q=<term>` searches.
 *
 * Most platforms accept `/search?q=` (VTEX, Shopify) or `/s?q=` (VTEX legacy).
 * If `searchUrlHint` is set in rc.search, use that; otherwise we'll attempt
 * `/search?q=<term>` first and `/s?q=<term>` as fallback — Playwright will
 * follow whichever 404s vs renders.
 */
function searchUrlFor(baseUrl: string, term: string, path = "/search"): string {
  const u = new URL(path, baseUrl);
  u.searchParams.set("q", term);
  return u.toString();
}

async function flowSearch(ctx: FlowContext): Promise<FlowResult> {
  const pages: PageCapture[] = [];
  const steps: StepCapture[] = [];
  const total = 6;
  const reportStart = (idx: number, name: string) =>
    ctx.onStep?.({ phase: "start", name, index: idx, total });
  const reportEnd = (
    idx: number,
    name: string,
    status: StepCapture["status"],
    durationMs: number,
    note?: string,
  ) => ctx.onStep?.({ phase: "end", name, index: idx, total, status, durationMs, note });

  const typeDelayMs = ctx.rc.search?.typeDelayMs ?? 80;
  const budget = { remaining: ctx.recoveryBudget ?? 3 };
  const page = await ctx.ctx.newPage();

  try {
    // Step 1: visit-home
    reportStart(1, "visit-home");
    const homeCap = await capturePage(page, {
      url: ctx.baseUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "search-1-home"),
    });
    pages.push(homeCap);
    const step1Status: StepCapture["status"] =
      homeCap.status >= 200 && homeCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 1,
      name: "visit-home",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step1Status,
      durationMs: homeCap.durationMs,
      url: homeCap.finalUrl,
      screenshotPath: homeCap.screenshotPath,
      actionDescription: `Navegou pra home \`${ctx.baseUrl}\` (HTTP ${homeCap.status})`,
    });
    reportEnd(1, "visit-home", step1Status, homeCap.durationMs);
    if (step1Status === "failed") return { pages, steps };

    // Resolve search terms (with-results + no-results)
    const terms = await resolveSearchTerms(ctx.baseUrl, homeCap.html, {
      rc: ctx.rc,
      runId: ctx.runId,
    }).catch(() => ({ withResults: "produto", noResults: `zzqxxq-${Date.now().toString(36)}` }));

    // Step 2: open-search — click trigger if input not already visible.
    // `findElement` handles the cascade (override → learned → defaults → LLM recovery).
    reportStart(2, "open-search");
    const t2 = Date.now();
    let inputHit = await findElement(page, ctx, {
      key: "searchInput",
      intent:
        "Encontrar o <input> de BUSCA na página (campo de texto onde o usuário digita o termo a buscar). NÃO retorne input de email, newsletter, ou CEP.",
      budget,
      stepName: "find-search-input",
    });
    let usedTrigger: string | null = null;
    let triggerRecoveredByLlm = false;
    let inputRecoveredByLlm = inputHit?.recoveredByLlm ?? false;

    if (!inputHit) {
      const triggerHit = await findElement(page, ctx, {
        key: "searchTrigger",
        intent:
          "Encontrar o ícone/botão de lupa/busca no header que ABRE o input de busca quando clicado (mobile geralmente esconde o input atrás de um trigger).",
        budget,
        stepName: "open-search-trigger",
      });
      if (triggerHit) {
        usedTrigger = triggerHit.selector;
        triggerRecoveredByLlm = triggerHit.recoveredByLlm;
        await withCap(
          triggerHit.locator.click({ timeout: 3_000 }).catch(() => undefined),
          4_000,
          undefined,
        );
        await page.waitForTimeout(500);
        // Try cascade again now that the input might be visible.
        inputHit = await findElement(page, ctx, {
          key: "searchInput",
          intent:
            "Após clicar no trigger de busca, encontrar o <input> de BUSCA que apareceu (não confundir com email/CEP).",
          budget,
          stepName: "find-search-input-after-trigger",
        });
        if (inputHit?.recoveredByLlm) inputRecoveredByLlm = true;
      }
    }
    if (!inputHit) {
      steps.push({
        ...makeSkipStep(
          2,
          "open-search",
          ctx,
          "search input not detected (incluindo recovery LLM)",
        ),
        actionDescription: "Não encontramos input de busca — flow skipado.",
      });
      reportEnd(2, "open-search", "skipped", Date.now() - t2, "search input not detected");
      // Try one more thing: navigate directly to /search?q=<term> for step 4.
      // But skip steps 3 (autocomplete) and 6 (empty state) gracefully.
      // Continue to step 4 below using URL-based search.
    } else {
      const recoverNote = [
        triggerRecoveredByLlm ? "trigger via LLM" : null,
        inputRecoveredByLlm ? "input via LLM" : null,
      ]
        .filter(Boolean)
        .join(", ");
      steps.push({
        step: 2,
        name: "open-search",
        side: ctx.side,
        viewport: ctx.viewport,
        status: "ok",
        durationMs: Date.now() - t2,
        screenshotPath: screenshotPath(ctx, "search-2-open"),
        selectorKey: "searchInput",
        usedSelector: inputHit.selector,
        recoveredByLlm: triggerRecoveredByLlm || inputRecoveredByLlm || undefined,
        actionDescription: usedTrigger
          ? `Clicou trigger \`${usedTrigger}\` e revelou input \`${inputHit.selector}\`${recoverNote ? ` (${recoverNote})` : ""}`
          : `Input de busca visível: \`${inputHit.selector}\`${recoverNote ? ` (${recoverNote})` : ""}`,
      });
      reportEnd(2, "open-search", "ok", Date.now() - t2);
      await screenshotStable(page, { path: screenshotPath(ctx, "search-2-open") });
    }

    // Step 3: type-and-autocomplete — type with delay, wait for suggestions
    reportStart(3, "type-and-autocomplete");
    const t3 = Date.now();
    let suggestionCount = 0;
    let autocompleteSelectorUsed: string | undefined;
    if (inputHit) {
      await withCap(
        inputHit.locator
          .pressSequentially(terms.withResults, { delay: typeDelayMs, timeout: 5_000 })
          .catch(() => undefined),
        Math.max(5_000, terms.withResults.length * (typeDelayMs + 50)),
        undefined,
      );
      // Wait for any suggestions container to appear; first to win.
      const suggestionSelectors = selFor(ctx, "searchSuggestions");
      for (const sel of suggestionSelectors) {
        try {
          const loc = page.locator(sel).first();
          const visible = await withCap(
            loc
              .waitFor({ state: "visible", timeout: 3_000 })
              .then(() => true)
              .catch(() => false),
            3_500,
            false,
          );
          if (visible) {
            autocompleteSelectorUsed = sel;
            // Count children that look like suggestion items.
            suggestionCount = await withCap(
              page
                .locator(`${sel} a, ${sel} li, ${sel} [role='option']`)
                .count()
                .catch(() => 0),
              1_500,
              0,
            );
            break;
          }
        } catch {
          /* try next */
        }
      }
    }
    const step3Status: StepCapture["status"] = inputHit
      ? "ok" // ok even without autocomplete — the check decides if absence is a regression
      : "skipped";
    steps.push({
      step: 3,
      name: "type-and-autocomplete",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step3Status,
      durationMs: Date.now() - t3,
      screenshotPath: screenshotPath(ctx, "search-3-autocomplete"),
      selectorKey: "searchSuggestions",
      usedSelector: autocompleteSelectorUsed,
      actionDescription: inputHit
        ? `Digitou "${terms.withResults}" e ${
            autocompleteSelectorUsed ? `viu ${suggestionCount} sugestões` : "não viu autocomplete"
          }`
        : "Sem input — autocomplete skipado.",
      searchValidation: {
        term: terms.withResults,
        mode: "autocomplete",
        suggestionCount,
      },
    });
    if (inputHit)
      await screenshotStable(page, { path: screenshotPath(ctx, "search-3-autocomplete") });
    reportEnd(3, "type-and-autocomplete", step3Status, Date.now() - t3);

    // Step 4: submit-results — press Enter or navigate URL-based
    reportStart(4, "submit-results");
    const t4 = Date.now();
    let resultsCap: PageCapture | null = null;
    if (inputHit) {
      // Submit via Enter
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined),
        inputHit.locator.press("Enter").catch(() => undefined),
      ]);
      // Wait a beat for the SPA to settle
      await page.waitForTimeout(1_000);
      resultsCap = await capturePage(page, {
        url: page.url(),
        side: ctx.side,
        viewport: ctx.viewport,
        screenshotPath: screenshotPath(ctx, "search-4-results"),
      });
    } else {
      // Fallback: navigate URL-based
      resultsCap = await capturePage(page, {
        url: searchUrlFor(ctx.baseUrl, terms.withResults),
        side: ctx.side,
        viewport: ctx.viewport,
        screenshotPath: screenshotPath(ctx, "search-4-results"),
      });
    }
    pages.push(resultsCap);
    const resultCount = await countProductCards(page);
    const step4Status: StepCapture["status"] =
      resultsCap.status >= 200 && resultsCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 4,
      name: "submit-results",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step4Status,
      durationMs: Date.now() - t4,
      url: resultsCap.finalUrl,
      screenshotPath: resultsCap.screenshotPath,
      actionDescription: `Submeteu busca "${terms.withResults}" — HTTP ${resultsCap.status}, ${resultCount} produtos detectados`,
      searchValidation: {
        term: terms.withResults,
        mode: "results",
        resultCount,
      },
    });
    reportEnd(4, "submit-results", step4Status, Date.now() - t4);

    // Step 5: search-no-results — exercise the empty state
    reportStart(5, "search-no-results");
    const t5 = Date.now();
    const noResultsCap = await capturePage(page, {
      url: searchUrlFor(ctx.baseUrl, terms.noResults),
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "search-5-no-results"),
    });
    pages.push(noResultsCap);
    // Wait for SPA hydration — VTEX Intelligent Search renders the empty-state
    // banner client-side after the SSR shell. Without this wait, innerText
    // and the per-page HTML both miss the "Nenhum resultado" message.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const nrResultCount = await countProductCards(page);
    const hasEmptyState = await detectNoResultsEmptyState(page, noResultsCap.html, terms.noResults);
    const step5Status: StepCapture["status"] =
      noResultsCap.status >= 200 && noResultsCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 5,
      name: "search-no-results",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step5Status,
      durationMs: Date.now() - t5,
      url: noResultsCap.finalUrl,
      screenshotPath: noResultsCap.screenshotPath,
      actionDescription: `Buscou termo unicode "${terms.noResults}" — ${nrResultCount} produtos, empty state ${hasEmptyState ? "visível" : "ausente"}`,
      searchValidation: {
        term: terms.noResults,
        mode: "no-results",
        resultCount: nrResultCount,
        hasEmptyState,
      },
    });
    reportEnd(5, "search-no-results", step5Status, Date.now() - t5);

    // Step 6: search-empty-state — /search with no query
    reportStart(6, "search-empty-state");
    const t6 = Date.now();
    const emptyCap = await capturePage(page, {
      url: new URL("/search", ctx.baseUrl).toString(),
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "search-6-empty"),
    });
    pages.push(emptyCap);
    const step6Status: StepCapture["status"] =
      emptyCap.status >= 200 && emptyCap.status < 500 ? "ok" : "failed";
    steps.push({
      step: 6,
      name: "search-empty-state",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step6Status,
      durationMs: Date.now() - t6,
      url: emptyCap.finalUrl,
      screenshotPath: emptyCap.screenshotPath,
      actionDescription: `Visitou /search sem query — HTTP ${emptyCap.status}`,
      searchValidation: {
        term: "",
        mode: "empty",
      },
    });
    reportEnd(6, "search-empty-state", step6Status, Date.now() - t6);
  } finally {
    await page.close().catch(() => undefined);
  }

  return { pages, steps };
}

/**
 * Read the quantity input value + total price from an open minicart/cart.
 *
 * Best-effort: any selector miss returns undefined for that field.
 */
async function parseCartTotals(
  page: Page,
  ctx: FlowContext,
): Promise<{ qty?: number; price?: string }> {
  const out: { qty?: number; price?: string } = {};
  // Qty: try quantityInput inside any cart row, else any visible quantity input.
  const qtySelectors = [
    ...selFor(ctx, "cartItemRow").map((s) => `${s} input[type='number']`),
    ...selFor(ctx, "quantityInput"),
  ];
  for (const sel of qtySelectors) {
    const value = await withCap(
      page
        .locator(sel)
        .first()
        .inputValue()
        .catch(() => ""),
      1_000,
      "",
    );
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) {
      out.qty = n;
      break;
    }
  }
  // Price: cartTotalPrice innerText
  for (const sel of selFor(ctx, "cartTotalPrice")) {
    const text = await withCap(
      page
        .locator(sel)
        .first()
        .innerText()
        .catch(() => ""),
      1_000,
      "",
    );
    if (text.trim()) {
      out.price = text.trim().slice(0, 60);
      break;
    }
  }
  return out;
}

/**
 * Seed an item into the cart by replaying a slim version of PJ steps 1-6
 * (home → PLP → PDP → add-to-cart) + step 7 (open-minicart). Returns the
 * pages captured + the minicart open status. Used by flowCartInteractions.
 *
 * This is best-effort: any failure (no PDP found, variant required, etc)
 * surfaces as a "skipped" step. Variant selection complexity is intentionally
 * omitted — sites that require variants will skip cart-interactions, which
 * is a reasonable default.
 */
async function seedCartForInteractions(
  page: Page,
  ctx: FlowContext,
): Promise<{ pages: PageCapture[]; opened: boolean; note?: string }> {
  const pages: PageCapture[] = [];
  // Home
  const homeCap = await capturePage(page, {
    url: ctx.baseUrl,
    side: ctx.side,
    viewport: ctx.viewport,
    screenshotPath: screenshotPath(ctx, "cart-seed-home"),
  });
  pages.push(homeCap);
  if (homeCap.status >= 400) return { pages, opened: false, note: `home HTTP ${homeCap.status}` };

  // PLP
  const plpHit = ctx.rc.plpUrlHint
    ? { url: new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString(), selector: "__hint__" }
    : await findCategoryUrl(page, ctx);
  if (!plpHit) return { pages, opened: false, note: "no category link found" };
  const plpCap = await capturePage(page, {
    url: plpHit.url,
    side: ctx.side,
    viewport: ctx.viewport,
    screenshotPath: screenshotPath(ctx, "cart-seed-plp"),
  });
  pages.push(plpCap);
  if (plpCap.status >= 400) return { pages, opened: false, note: `plp HTTP ${plpCap.status}` };

  // PDP
  const pdpHit = await findProductUrl(page, ctx);
  if (!pdpHit) return { pages, opened: false, note: "no product card on PLP" };
  const pdpCap = await capturePage(page, {
    url: pdpHit.url,
    side: ctx.side,
    viewport: ctx.viewport,
    screenshotPath: screenshotPath(ctx, "cart-seed-pdp"),
  });
  pages.push(pdpCap);
  if (pdpCap.status >= 400) return { pages, opened: false, note: `pdp HTTP ${pdpCap.status}` };

  // Add to cart (no variant handling — best-effort)
  const buyHit = await firstVisibleLocator(page, selFor(ctx, "buyButton"));
  if (!buyHit) return { pages, opened: false, note: "no buy button on PDP" };
  await buyHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);

  // Open minicart
  const miniHit = await firstVisibleLocator(page, selFor(ctx, "minicartTrigger"));
  if (!miniHit) return { pages, opened: false, note: "minicart trigger not found" };
  await miniHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);

  // Heuristic confirmation: at least one cart item row visible
  const rowHit = await firstVisibleLocator(page, selFor(ctx, "cartItemRow"));
  return {
    pages,
    opened: !!rowHit,
    note: rowHit ? undefined : "no cart item visible after add-to-cart",
  };
}

async function flowCartInteractions(ctx: FlowContext): Promise<FlowResult> {
  const pages: PageCapture[] = [];
  const steps: StepCapture[] = [];
  const total = 7;
  const budget = { remaining: ctx.recoveryBudget ?? 3 };
  const reportStart = (idx: number, name: string) =>
    ctx.onStep?.({ phase: "start", name, index: idx, total });
  const reportEnd = (
    idx: number,
    name: string,
    status: StepCapture["status"],
    durationMs: number,
    note?: string,
  ) => ctx.onStep?.({ phase: "end", name, index: idx, total, status, durationMs, note });

  const page = await ctx.ctx.newPage();
  try {
    // Step 1: seed-cart (home → PLP → PDP → add → open minicart)
    reportStart(1, "seed-cart");
    const t1 = Date.now();
    const seed = await seedCartForInteractions(page, ctx);
    pages.push(...seed.pages);
    const step1Status: StepCapture["status"] = seed.opened ? "ok" : "skipped";
    steps.push({
      step: 1,
      name: "seed-cart",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step1Status,
      durationMs: Date.now() - t1,
      url: page.url(),
      screenshotPath: screenshotPath(ctx, "cart-seed-end"),
      note: seed.note,
      actionDescription: seed.opened
        ? "Carrinho aberto com 1 item (home → PLP → PDP → add → minicart)"
        : `Não conseguiu semear carrinho: ${seed.note ?? "razão desconhecida"}`,
    });
    if (seed.opened) await screenshotStable(page, { path: screenshotPath(ctx, "cart-seed-end") });
    reportEnd(1, "seed-cart", step1Status, Date.now() - t1, seed.note);
    if (!seed.opened) {
      // Skip all subsequent steps
      for (let i = 2; i <= 7; i++) {
        steps.push(
          makeSkipStep(
            i,
            [
              "read-baseline",
              "increment-qty",
              "decrement-qty",
              "apply-invalid-coupon",
              "remove-item",
              "verify-empty-state",
            ][i - 2]!,
            ctx,
            "cart-not-seeded",
          ),
        );
      }
      return { pages, steps };
    }

    // Step 2: read-baseline
    reportStart(2, "read-baseline");
    const t2 = Date.now();
    const baseline = await parseCartTotals(page, ctx);
    steps.push({
      step: 2,
      name: "read-baseline",
      side: ctx.side,
      viewport: ctx.viewport,
      status: "ok",
      durationMs: Date.now() - t2,
      screenshotPath: screenshotPath(ctx, "cart-2-baseline"),
      actionDescription: `Baseline: qty=${baseline.qty ?? "?"}, price=${baseline.price ?? "?"}`,
      detail: { baseline },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-2-baseline") });
    reportEnd(2, "read-baseline", "ok", Date.now() - t2);

    // Step 3: increment-qty
    reportStart(3, "increment-qty");
    const t3 = Date.now();
    const incHit = await findElement(page, ctx, {
      key: "cartQuantityIncrement",
      intent:
        "Encontrar o botão '+' / 'aumentar quantidade' dentro de um item do carrinho aberto (minicart drawer ou /cart). Não confundir com botão de promoção/cupom.",
      budget,
      stepName: "cart-increment",
    });
    let incAfter: { qty?: number; price?: string } = {};
    let incOk = false;
    if (incHit) {
      await incHit.locator.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      incAfter = await parseCartTotals(page, ctx);
      incOk = (incAfter.qty ?? 0) > (baseline.qty ?? 0);
    }
    steps.push({
      step: 3,
      name: "increment-qty",
      side: ctx.side,
      viewport: ctx.viewport,
      status: incHit ? (incOk ? "ok" : "failed") : "skipped",
      durationMs: Date.now() - t3,
      screenshotPath: screenshotPath(ctx, "cart-3-increment"),
      selectorKey: "cartQuantityIncrement",
      usedSelector: incHit?.selector,
      actionDescription: incHit
        ? `Click increment → qty ${baseline.qty ?? "?"} → ${incAfter.qty ?? "?"}`
        : "Increment button não encontrado",
      cartItemValidation: {
        action: "increment",
        before: baseline,
        after: incAfter,
        succeeded: incOk,
      },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-3-increment") });
    reportEnd(3, "increment-qty", incHit ? (incOk ? "ok" : "failed") : "skipped", Date.now() - t3);

    // Step 4: decrement-qty
    reportStart(4, "decrement-qty");
    const t4 = Date.now();
    const decHit = await findElement(page, ctx, {
      key: "cartQuantityDecrement",
      intent: "Encontrar o botão '-' / 'diminuir quantidade' dentro de um item do carrinho aberto.",
      budget,
      stepName: "cart-decrement",
    });
    let decAfter: { qty?: number; price?: string } = {};
    let decOk = false;
    if (decHit) {
      await decHit.locator.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      decAfter = await parseCartTotals(page, ctx);
      decOk = (decAfter.qty ?? 0) < (incAfter.qty ?? Number.POSITIVE_INFINITY);
    }
    steps.push({
      step: 4,
      name: "decrement-qty",
      side: ctx.side,
      viewport: ctx.viewport,
      status: decHit ? (decOk ? "ok" : "failed") : "skipped",
      durationMs: Date.now() - t4,
      screenshotPath: screenshotPath(ctx, "cart-4-decrement"),
      selectorKey: "cartQuantityDecrement",
      usedSelector: decHit?.selector,
      actionDescription: decHit
        ? `Click decrement → qty ${incAfter.qty ?? "?"} → ${decAfter.qty ?? "?"}`
        : "Decrement button não encontrado",
      cartItemValidation: {
        action: "decrement",
        before: incAfter,
        after: decAfter,
        succeeded: decOk,
      },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-4-decrement") });
    reportEnd(4, "decrement-qty", decHit ? (decOk ? "ok" : "failed") : "skipped", Date.now() - t4);

    // Step 5: apply-invalid-coupon
    reportStart(5, "apply-invalid-coupon");
    const t5 = Date.now();
    const couponInputHit = await findElement(page, ctx, {
      key: "cartCouponInput",
      intent:
        "Encontrar o <input> de CUPOM / código promocional no carrinho aberto (placeholder costuma ser 'Digite seu cupom', 'Insira o código'). NÃO confundir com input de CEP/frete.",
      budget,
      stepName: "cart-coupon-input",
    });
    const before5 = await parseCartTotals(page, ctx);
    let couponErrorShown = false;
    let couponSubmitted = false;
    if (couponInputHit) {
      await couponInputHit.locator.fill("INVALIDCOUPON123-XYZ").catch(() => undefined);
      const submitHit = await findElement(page, ctx, {
        key: "cartCouponSubmit",
        intent:
          "Encontrar o botão de submeter cupom — 'Aplicar', 'Apply', 'Validar' — junto ao input de cupom no carrinho.",
        budget,
        stepName: "cart-coupon-submit",
      });
      if (submitHit) {
        couponSubmitted = true;
        await submitHit.locator.click({ timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
        // Detect error: page text mentions inválido/invalid/não encontrado
        const text = await withCap(
          page
            .locator("body")
            .innerText()
            .catch(() => ""),
          1_500,
          "",
        );
        couponErrorShown = /(inv[aá]lid|n[aã]o encontrado|n[aã]o existe|expired|expirado)/i.test(
          text,
        );
      }
    }
    const after5 = await parseCartTotals(page, ctx);
    const totalUnchanged = before5.price === after5.price;
    const couponStatus: StepCapture["status"] = couponInputHit
      ? couponSubmitted
        ? couponErrorShown && totalUnchanged
          ? "ok"
          : "failed"
        : "skipped"
      : "skipped";
    steps.push({
      step: 5,
      name: "apply-invalid-coupon",
      side: ctx.side,
      viewport: ctx.viewport,
      status: couponStatus,
      durationMs: Date.now() - t5,
      screenshotPath: screenshotPath(ctx, "cart-5-coupon"),
      selectorKey: "cartCouponInput",
      usedSelector: couponInputHit?.selector,
      actionDescription: couponInputHit
        ? couponSubmitted
          ? `Cupom inválido aplicado — erro visível: ${couponErrorShown}, total inalterado: ${totalUnchanged}`
          : "Coupon input encontrado, submit button ausente"
        : "Coupon input não encontrado",
      cartItemValidation: {
        action: "apply-coupon",
        before: before5,
        after: after5,
        succeeded: couponStatus === "ok",
      },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-5-coupon") });
    reportEnd(5, "apply-invalid-coupon", couponStatus, Date.now() - t5);

    // Step 6: remove-item
    reportStart(6, "remove-item");
    const t6 = Date.now();
    const removeHit = await findElement(page, ctx, {
      key: "cartRemoveItem",
      intent:
        "Encontrar o botão de REMOVER ITEM (ícone de lixeira, 'Remover', 'Excluir') dentro de um item do carrinho. Não confundir com fechar minicart drawer.",
      budget,
      stepName: "cart-remove-item",
    });
    let removed = false;
    if (removeHit) {
      await removeHit.locator.click({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      // Removed if no cart-item-row remains visible
      const stillThere = await firstVisibleLocator(page, selFor(ctx, "cartItemRow"));
      removed = !stillThere;
    }
    steps.push({
      step: 6,
      name: "remove-item",
      side: ctx.side,
      viewport: ctx.viewport,
      status: removeHit ? (removed ? "ok" : "failed") : "skipped",
      durationMs: Date.now() - t6,
      screenshotPath: screenshotPath(ctx, "cart-6-remove"),
      selectorKey: "cartRemoveItem",
      usedSelector: removeHit?.selector,
      actionDescription: removeHit
        ? removed
          ? "Item removido — carrinho vazio"
          : "Click no remove mas item ainda visível"
        : "Remove button não encontrado",
      cartItemValidation: {
        action: "remove",
        before: after5,
        after: { qty: removed ? 0 : after5.qty },
        succeeded: removed,
      },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-6-remove") });
    reportEnd(
      6,
      "remove-item",
      removeHit ? (removed ? "ok" : "failed") : "skipped",
      Date.now() - t6,
    );

    // Step 7: verify-empty-state
    reportStart(7, "verify-empty-state");
    const t7 = Date.now();
    const emptyText = await detectEmptyCartBanner(page);
    const emptyStatus: StepCapture["status"] = emptyText ? "ok" : removed ? "failed" : "skipped";
    steps.push({
      step: 7,
      name: "verify-empty-state",
      side: ctx.side,
      viewport: ctx.viewport,
      status: emptyStatus,
      durationMs: Date.now() - t7,
      screenshotPath: screenshotPath(ctx, "cart-7-empty"),
      actionDescription: emptyText
        ? `Empty state visível: "${emptyText.slice(0, 80)}"`
        : "Empty state não detectado",
      note: emptyText ?? undefined,
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-7-empty") });
    reportEnd(7, "verify-empty-state", emptyStatus, Date.now() - t7);
  } finally {
    await page.close().catch(() => undefined);
  }

  return { pages, steps };
}

/**
 * Login flow — gated. Only runs when:
 *  1. `ctx.rc.login?.enabled === true`
 *  2. env vars `PARITY_LOGIN_EMAIL` AND `PARITY_LOGIN_PASSWORD` are set.
 *
 * If either condition is missing, the flow returns a homepage capture and
 * all login steps marked `skipped` — so the check can distinguish "not
 * enabled" from "broken login".
 *
 * Credential handling: env vars only. NEVER read credentials from
 * `.parityrc.json` (which is committed to git). Passwords are not echoed
 * to logs, screenshots, or HTML capture — `fill()` masks the password
 * input by default, and we set `inputmask='password'` discipline by only
 * using the inputs we discovered.
 */
async function flowLogin(ctx: FlowContext): Promise<FlowResult> {
  const pages: PageCapture[] = [];
  const steps: StepCapture[] = [];
  const total = 5;
  const reportStart = (idx: number, name: string) =>
    ctx.onStep?.({ phase: "start", name, index: idx, total });
  const reportEnd = (
    idx: number,
    name: string,
    status: StepCapture["status"],
    durationMs: number,
    note?: string,
  ) => ctx.onStep?.({ phase: "end", name, index: idx, total, status, durationMs, note });

  const enabled = ctx.rc.login?.enabled === true;
  const email = process.env.PARITY_LOGIN_EMAIL;
  const password = process.env.PARITY_LOGIN_PASSWORD;
  const credentialsPresent = !!email && !!password;
  const budget = { remaining: ctx.recoveryBudget ?? 3 };

  const page = await ctx.ctx.newPage();
  try {
    // Step 1: visit-home (always runs so we have a screenshot baseline)
    reportStart(1, "visit-home");
    const homeCap = await capturePage(page, {
      url: ctx.baseUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "login-1-home"),
    });
    pages.push(homeCap);
    const step1Status: StepCapture["status"] =
      homeCap.status >= 200 && homeCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 1,
      name: "visit-home",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step1Status,
      durationMs: homeCap.durationMs,
      url: homeCap.finalUrl,
      screenshotPath: homeCap.screenshotPath,
      actionDescription: `Navegou pra home \`${ctx.baseUrl}\``,
    });
    reportEnd(1, "visit-home", step1Status, homeCap.durationMs);

    if (!enabled || !credentialsPresent) {
      const reason = !enabled
        ? "login.enabled !== true in .parityrc.json"
        : "PARITY_LOGIN_EMAIL/PASSWORD not set";
      for (let i = 2; i <= 5; i++) {
        steps.push(
          makeSkipStep(
            i,
            ["open-login", "submit-invalid", "submit-valid", "verify-account-area"][i - 2]!,
            ctx,
            reason,
          ),
        );
      }
      return { pages, steps };
    }

    // Step 2: open-login — click trigger OR navigate to /login
    reportStart(2, "open-login");
    const t2 = Date.now();
    let emailHit = await findElement(page, ctx, {
      key: "loginEmailInput",
      intent:
        "Encontrar o <input> de email no formulário de login (NÃO confundir com input de newsletter ou cadastro).",
      budget,
      stepName: "login-email-input",
    });
    if (!emailHit) {
      const triggerHit = await findElement(page, ctx, {
        key: "loginTrigger",
        intent:
          "Encontrar o link/botão 'Entrar' / 'Login' / 'Minha conta' no header que abre o formulário de login.",
        budget,
        stepName: "login-trigger",
      });
      if (triggerHit) {
        await triggerHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
        emailHit = await findElement(page, ctx, {
          key: "loginEmailInput",
          intent: "Após clicar em 'Entrar', encontrar o <input> de email no form de login.",
          budget,
          stepName: "login-email-after-trigger",
        });
      }
    }
    if (!emailHit) {
      // Last resort: navigate to /login
      await page
        .goto(new URL("/login", ctx.baseUrl).toString(), { timeout: 15_000 })
        .catch(() => undefined);
      await page.waitForTimeout(1_000);
      emailHit = await findElement(page, ctx, {
        key: "loginEmailInput",
        intent: "Em /login, encontrar o <input> de email do formulário.",
        budget,
        stepName: "login-email-on-login-page",
      });
    }
    const passwordHit = emailHit
      ? await findElement(page, ctx, {
          key: "loginPasswordInput",
          intent: "Encontrar o <input> de senha (type='password') no formulário de login.",
          budget,
          stepName: "login-password-input",
        })
      : null;
    const formReady = !!(emailHit && passwordHit);
    steps.push({
      step: 2,
      name: "open-login",
      side: ctx.side,
      viewport: ctx.viewport,
      status: formReady ? "ok" : "failed",
      durationMs: Date.now() - t2,
      url: page.url(),
      screenshotPath: screenshotPath(ctx, "login-2-form"),
      selectorKey: "loginEmailInput",
      usedSelector: emailHit?.selector,
      actionDescription: formReady
        ? `Form de login carregado (\`${emailHit!.selector}\` + password)`
        : "Form de login não encontrado",
      loginValidation: { stage: "form-loaded" },
    });
    if (formReady) await screenshotStable(page, { path: screenshotPath(ctx, "login-2-form") });
    reportEnd(2, "open-login", formReady ? "ok" : "failed", Date.now() - t2);
    if (!formReady) {
      for (let i = 3; i <= 5; i++) {
        steps.push(
          makeSkipStep(
            i,
            ["submit-invalid", "submit-valid", "verify-account-area"][i - 3]!,
            ctx,
            "form-not-loaded",
          ),
        );
      }
      return { pages, steps };
    }

    // Step 3: submit-invalid — wrong credentials, expect error
    reportStart(3, "submit-invalid");
    const t3 = Date.now();
    await emailHit!.locator
      .fill(`invalid-${Date.now()}@parity-test.invalid`)
      .catch(() => undefined);
    await passwordHit!.locator.fill("wrong-password-on-purpose").catch(() => undefined);
    const submitHit = await findElement(page, ctx, {
      key: "loginSubmit",
      intent:
        "Encontrar o botão de submeter login ('Entrar', 'Login', 'Acessar') dentro do form de login.",
      budget,
      stepName: "login-submit",
    });
    if (submitHit) await submitHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const errorHit = await findElement(page, ctx, {
      key: "loginErrorMessage",
      intent:
        "Encontrar a mensagem de erro mostrada após login falho — geralmente em [role='alert'] ou perto do form.",
      budget,
      stepName: "login-error-message",
    });
    const errorMsg = errorHit
      ? await withCap(
          errorHit.locator.innerText().catch(() => ""),
          1_500,
          "",
        )
      : "";
    const errorShown =
      !!errorHit || /invalid|inv[aá]lid|incorret|n[aã]o (existe|cadastrad)/i.test(errorMsg);
    steps.push({
      step: 3,
      name: "submit-invalid",
      side: ctx.side,
      viewport: ctx.viewport,
      status: errorShown ? "ok" : "failed",
      durationMs: Date.now() - t3,
      url: page.url(),
      screenshotPath: screenshotPath(ctx, "login-3-invalid"),
      actionDescription: errorShown
        ? `Erro de credencial inválida visível: "${errorMsg.slice(0, 80)}"`
        : "Submit de credencial inválida não mostrou erro",
      loginValidation: {
        stage: "error-shown",
        errorMessage: errorMsg.slice(0, 200) || undefined,
      },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "login-3-invalid") });
    reportEnd(3, "submit-invalid", errorShown ? "ok" : "failed", Date.now() - t3);

    // Step 4: submit-valid — real credentials, expect redirect to account area
    reportStart(4, "submit-valid");
    const t4 = Date.now();
    // Re-find inputs (form may have been re-rendered after error)
    const emailHit2 = await firstVisibleLocator(page, selFor(ctx, "loginEmailInput"));
    const passwordHit2 = await firstVisibleLocator(page, selFor(ctx, "loginPasswordInput"));
    if (emailHit2 && passwordHit2) {
      await emailHit2.locator.fill(email!).catch(() => undefined);
      await passwordHit2.locator.fill(password!).catch(() => undefined);
      const submitHit2 = await firstVisibleLocator(page, selFor(ctx, "loginSubmit"));
      if (submitHit2) {
        await Promise.all([
          page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined),
          submitHit2.locator.click({ timeout: 5_000 }).catch(() => undefined),
        ]);
        await page.waitForTimeout(2_000);
      }
    }
    const accountMenuHit = await findElement(page, ctx, {
      key: "accountMenuTrigger",
      intent:
        "Após login bem-sucedido, encontrar o menu de conta logada no header (avatar, 'Olá <nome>', link 'Minha conta').",
      budget,
      stepName: "login-account-menu",
    });
    const loggedIn = !!accountMenuHit;
    steps.push({
      step: 4,
      name: "submit-valid",
      side: ctx.side,
      viewport: ctx.viewport,
      status: loggedIn ? "ok" : "failed",
      durationMs: Date.now() - t4,
      url: page.url(),
      screenshotPath: screenshotPath(ctx, "login-4-valid"),
      actionDescription: loggedIn
        ? `Login bem-sucedido — accountMenu visível (\`${accountMenuHit!.selector}\`)`
        : "Login com credenciais reais não logou — accountMenu não detectado",
      loginValidation: { stage: loggedIn ? "succeeded" : "submitted" },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "login-4-valid") });
    reportEnd(4, "submit-valid", loggedIn ? "ok" : "failed", Date.now() - t4);

    // Step 5: verify-account-area — navigate to /account and check page renders
    reportStart(5, "verify-account-area");
    const t5 = Date.now();
    const accountUrlCandidates = ["/account", "/minha-conta", "/account/orders"];
    let accountCap: PageCapture | null = null;
    for (const path of accountUrlCandidates) {
      const cap = await capturePage(page, {
        url: new URL(path, ctx.baseUrl).toString(),
        side: ctx.side,
        viewport: ctx.viewport,
        screenshotPath: screenshotPath(ctx, "login-5-account"),
      });
      if (cap.status >= 200 && cap.status < 400) {
        accountCap = cap;
        break;
      }
    }
    if (accountCap) pages.push(accountCap);
    const step5Status: StepCapture["status"] = accountCap ? "ok" : "failed";
    steps.push({
      step: 5,
      name: "verify-account-area",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step5Status,
      durationMs: Date.now() - t5,
      url: accountCap?.finalUrl ?? page.url(),
      screenshotPath: accountCap?.screenshotPath ?? screenshotPath(ctx, "login-5-account"),
      actionDescription: accountCap
        ? `Área logada acessível em ${accountCap.finalUrl} (HTTP ${accountCap.status})`
        : "Nenhuma URL de account respondeu 2xx — sessão pode não ter persistido",
    });
    reportEnd(5, "verify-account-area", step5Status, Date.now() - t5);
  } finally {
    await page.close().catch(() => undefined);
  }

  return { pages, steps };
}
