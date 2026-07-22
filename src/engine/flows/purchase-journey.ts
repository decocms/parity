import type { Locator, Page } from "playwright";
import { suggestRecovery } from "../../llm/recover-step.ts";
import type { PageCapture, StepCapture } from "../../types/schema.ts";
import { capturePage } from "../collect.ts";
import {
  detectCartRevealMode,
  detectEmptyCartBanner,
  isCartRevealed,
  openMinicart,
  readCartCount,
  validateCartContainsTitle,
  waitForCartHydration,
} from "./cart-helpers.ts";
import type { FlowContext, StepActionResult } from "./shared.ts";
import {
  ADD_TO_CART_ERROR_PATTERNS,
  ADD_TO_CART_SUCCESS_PATTERNS,
  VARIANT_REQUIRED_TEXT_PATTERNS,
  attemptRecovery,
  attemptStepAction,
  clickAndMaybeWait,
  detectLandingPage,
  dlog,
  extractProductTitle,
  fillCep,
  findCategoryUrl,
  findProductUrl,
  firstVisible,
  firstVisibleLocator,
  makeSkipStep,
  screenshotPath,
  screenshotStable,
  selFor,
} from "./shared.ts";
import { scrollPageInChunks } from "./simple.ts";

const PURCHASE_JOURNEY_TOTAL_STEPS = 9;

interface PurchaseJourneyResult {
  pages: PageCapture[];
  steps: StepCapture[];
}

export async function flowPurchaseJourney(ctx: FlowContext): Promise<PurchaseJourneyResult> {
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
    if (!buyHit) {
      // Before burning LLM budget on recovery, sanity-check that this
      // page actually looks like a PDP. Some "PDP" URLs are landing pages
      // (no Product schema, no price, no buy form) — there's nothing to
      // recover. Bail honestly so the user knows the test stopped because
      // the page wasn't a PDP, not because the runner gave up.
      const landingCheck = await detectLandingPage(page);
      if (landingCheck.isLanding) {
        steps.push(
          makeSkipStep(
            6,
            "add-to-cart",
            ctx,
            `PDP appears to be a landing page (${landingCheck.reasons.join("; ")}) — no buy form to test`,
          ),
        );
        reportEnd(6, "add-to-cart", "skipped", 0, "landing page detected");
        return { pages, steps };
      }
      if (budget.remaining > 0) {
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

export interface VariantSelectionResult {
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
export async function selectVariant(page: Page, ctx: FlowContext): Promise<VariantSelectionResult> {
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
      // Deco TanStack variants are `<a href=".../p?skuId=N">` LINKS that
      // navigate to a different SKU URL — clicking triggers a full nav,
      // and the post-click work has to wait for the new page to settle
      // before checking selected-state or trying add-to-cart. `clickAndMaybeWait`
      // races the click with a short navigation wait; if no nav happens
      // (button radio case) it falls through immediately.
      await clickAndMaybeWait(page, sizeHit.locator, "sizeSwatch");
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
    await clickAndMaybeWait(page, colorHit.locator, "colorSwatch");
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

    // A dialog/drawer/notification that wasn't visible before became
    // visible. Combines the legacy hardcoded list with the new
    // `cartOpenedIndicator` selector key (Issue #102 follow-up) so users
    // can override per-site via `.parityrc.json` and the Deco TanStack
    // `[aria-label='Fechar notificação']` / `[aria-label='Fechar carrinho']`
    // patterns are tried automatically.
    const drawerSelectors = [
      ...selFor(ctx, "cartOpenedIndicator"),
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
