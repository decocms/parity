import type { Page } from "playwright";
import type { PageCapture, StepCapture } from "../../types/schema.ts";
import { capturePage } from "../collect.ts";
import { detectEmptyCartBanner, parseCartTotals } from "./cart-helpers.ts";
import type { FlowContext, FlowResult } from "./shared.ts";
import {
  findCategoryUrl,
  findElement,
  findProductUrl,
  firstVisibleLocator,
  makeSkipStep,
  screenshotPath,
  screenshotStable,
  selFor,
  withCap,
} from "./shared.ts";

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

export async function flowCartInteractions(ctx: FlowContext): Promise<FlowResult> {
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
