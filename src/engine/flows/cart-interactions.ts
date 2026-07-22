import type { Page } from "playwright";
import type { PageCapture, StepCapture } from "../../types/schema.ts";
import { capturePage } from "../collect.ts";
import {
  type CartTotals,
  detectEmptyCartBanner,
  openMinicart,
  parseCartTotals,
  parsePriceBRL,
  readCartCount,
  waitForCartMutation,
} from "./cart-helpers.ts";
import { selectVariant } from "./purchase-journey.ts";
import type { FlowContext, FlowResult } from "./shared.ts";
import {
  collectCandidateLinks,
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

const STEP_NAMES = [
  "seed-cart",
  "add-second-item",
  "validate-multi-item",
  "read-baseline",
  "increment-qty",
  "decrement-qty",
  "apply-invalid-coupon",
  "remove-item",
  "verify-empty-state",
] as const;
const TOTAL_STEPS = STEP_NAMES.length;

/**
 * Pure helper: pick the first product href from a PLP candidate list that
 * differs from the one already added to the cart. Returns null when the
 * PLP only surfaces one distinct product (e.g. a very narrow category) —
 * the caller should treat that as a "skipped", not a "failed", outcome.
 */
export function pickDifferentProductHref(hrefs: string[], exclude: string): string | null {
  for (const href of hrefs) {
    if (href !== exclude) return href;
  }
  return null;
}

/**
 * Seed an item into the cart by replaying a slim version of PJ steps 1-6
 * (home → PLP → PDP → add-to-cart) + step 7 (open-minicart). Returns the
 * pages captured + the minicart open status, plus the PLP URL and the
 * first product's href — both needed by `add-second-item` to pick a
 * DIFFERENT product on the same PLP.
 *
 * This is best-effort: any failure (no PDP found, etc) surfaces as a
 * "skipped" step. Variant selection is now handled via `selectVariant`
 * (same heuristic purchase-journey uses) so apparel/variant-gated stores
 * no longer skip this whole flow.
 */
async function seedCartForInteractions(
  page: Page,
  ctx: FlowContext,
): Promise<{
  pages: PageCapture[];
  opened: boolean;
  note?: string;
  plpUrl?: string;
  firstProductHref?: string;
}> {
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
  if (!pdpHit) return { pages, opened: false, note: "no product card on PLP", plpUrl: plpHit.url };
  const pdpCap = await capturePage(page, {
    url: pdpHit.url,
    side: ctx.side,
    viewport: ctx.viewport,
    screenshotPath: screenshotPath(ctx, "cart-seed-pdp"),
  });
  pages.push(pdpCap);
  if (pdpCap.status >= 400) {
    return {
      pages,
      opened: false,
      note: `pdp HTTP ${pdpCap.status}`,
      plpUrl: plpHit.url,
      firstProductHref: pdpHit.url,
    };
  }

  // Select a variant BEFORE clicking buy — same heuristic purchase-journey
  // uses (variant rows / size-swatch / color-swatch / zero-qty-increment).
  // Previously this flow skipped entirely on variant-required PDPs; now it
  // unlocks cart-interactions testing for apparel/variant-heavy stores.
  await selectVariant(page, ctx).catch(() => undefined);

  // Add to cart
  const buyHit = await firstVisibleLocator(page, selFor(ctx, "buyButton"));
  if (!buyHit) {
    return {
      pages,
      opened: false,
      note: "no buy button on PDP",
      plpUrl: plpHit.url,
      firstProductHref: pdpHit.url,
    };
  }
  await buyHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
  await waitForCartMutation(page, ctx, (t) => (t.qty ?? 0) > 0 || (t.items ?? 0) > 0);

  // Open minicart
  const miniHit = await firstVisibleLocator(page, selFor(ctx, "minicartTrigger"));
  if (!miniHit) {
    return {
      pages,
      opened: false,
      note: "minicart trigger not found",
      plpUrl: plpHit.url,
      firstProductHref: pdpHit.url,
    };
  }
  await miniHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);

  // Heuristic confirmation: at least one cart item row visible
  const rowHit = await firstVisibleLocator(page, selFor(ctx, "cartItemRow"));
  return {
    pages,
    opened: !!rowHit,
    note: rowHit ? undefined : "no cart item visible after add-to-cart",
    plpUrl: plpHit.url,
    firstProductHref: pdpHit.url,
  };
}

export async function flowCartInteractions(ctx: FlowContext): Promise<FlowResult> {
  const pages: PageCapture[] = [];
  const steps: StepCapture[] = [];
  const total = TOTAL_STEPS;
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
    // Step 1: seed-cart (home → PLP → PDP → select-variant → add → open minicart)
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
        ? "Carrinho aberto com 1 item (home → PLP → PDP → variante → add → minicart)"
        : `Não conseguiu semear carrinho: ${seed.note ?? "razão desconhecida"}`,
    });
    if (seed.opened) await screenshotStable(page, { path: screenshotPath(ctx, "cart-seed-end") });
    reportEnd(1, "seed-cart", step1Status, Date.now() - t1, seed.note);
    if (!seed.opened) {
      for (let i = 2; i <= total; i++) {
        steps.push(makeSkipStep(i, STEP_NAMES[i - 1]!, ctx, "cart-not-seeded"));
      }
      return { pages, steps };
    }

    // Single-item baseline — captured right here (BEFORE we navigate away
    // to add a second item) so `validate-multi-item` has something to
    // compare the post-second-add total against. `read-baseline` (step 4)
    // now runs AFTER the multi-item steps, so it captures the 2-item
    // state instead and can't serve this purpose.
    const singleItemBaseline = await parseCartTotals(page, ctx);
    const singleItemPrice = singleItemBaseline.price
      ? parsePriceBRL(singleItemBaseline.price)
      : null;

    // Step 2: add-second-item — navigate back to the seeded PLP, pick a
    // DIFFERENT product, add it too. Skipped (not failed) when the PLP
    // only has one distinct product.
    reportStart(2, "add-second-item");
    const t2 = Date.now();
    let secondItemAfter: CartTotals | undefined;
    let secondItemStatus: StepCapture["status"] = "skipped";
    let secondItemNote: string | undefined;
    if (!seed.plpUrl || !seed.firstProductHref) {
      secondItemNote = "PLP/first-product URL não disponível a partir do seed";
    } else {
      const plpCap2 = await capturePage(page, {
        url: seed.plpUrl,
        side: ctx.side,
        viewport: ctx.viewport,
        screenshotPath: screenshotPath(ctx, "cart-2b-plp-second"),
      });
      pages.push(plpCap2);
      const candidates = await collectCandidateLinks(page, selFor(ctx, "productCard"), 12);
      const secondHref = pickDifferentProductHref(
        candidates.map((c) => c.href),
        seed.firstProductHref,
      );
      if (!secondHref) {
        secondItemNote = "PLP só tem um produto distinto — não dá pra testar multi-item";
      } else {
        const pdpCap2 = await capturePage(page, {
          url: secondHref,
          side: ctx.side,
          viewport: ctx.viewport,
          screenshotPath: screenshotPath(ctx, "cart-2c-pdp-second"),
        });
        pages.push(pdpCap2);
        if (pdpCap2.status >= 400) {
          secondItemNote = `pdp (2º produto) HTTP ${pdpCap2.status}`;
          secondItemStatus = "failed";
        } else {
          await selectVariant(page, ctx).catch(() => undefined);
          const buyHit2 = await firstVisibleLocator(page, selFor(ctx, "buyButton"));
          if (!buyHit2) {
            secondItemNote = "sem buy button no 2º PDP";
            secondItemStatus = "failed";
          } else {
            await buyHit2.locator.click({ timeout: 5_000 }).catch(() => undefined);
            await waitForCartMutation(
              page,
              ctx,
              (t) => (t.items ?? 0) >= 2 || (t.totalQty ?? 0) >= 2,
            );
            const miniHit2 = await firstVisibleLocator(page, selFor(ctx, "minicartTrigger"));
            if (miniHit2) {
              await openMinicart(page, miniHit2, ctx, null);
            }
            secondItemAfter = await waitForCartMutation(
              page,
              ctx,
              (t) => (t.items ?? 0) >= 2 || (t.totalQty ?? 0) >= 2,
            );
            const countAfter2 = await readCartCount(page, ctx);
            secondItemStatus =
              (secondItemAfter.items ?? 0) >= 2 ||
              (secondItemAfter.totalQty ?? 0) >= 2 ||
              countAfter2 >= 2
                ? "ok"
                : "failed";
            secondItemNote =
              secondItemStatus === "ok" ? undefined : "2º item não refletiu no carrinho";
          }
        }
      }
    }
    steps.push({
      step: 2,
      name: "add-second-item",
      side: ctx.side,
      viewport: ctx.viewport,
      status: secondItemStatus,
      durationMs: Date.now() - t2,
      url: page.url(),
      screenshotPath: screenshotPath(ctx, "cart-2-second-item"),
      note: secondItemNote,
      actionDescription:
        secondItemStatus === "ok"
          ? `2º produto adicionado — items=${secondItemAfter?.items ?? "?"}, totalQty=${secondItemAfter?.totalQty ?? "?"}`
          : `Add-second-item ${secondItemStatus}: ${secondItemNote ?? ""}`,
      cartItemValidation: {
        action: "add-second-item",
        before: singleItemBaseline,
        after: secondItemAfter,
        succeeded: secondItemStatus === "ok",
      },
    });
    if (secondItemStatus !== "skipped") {
      await screenshotStable(page, { path: screenshotPath(ctx, "cart-2-second-item") });
    }
    reportEnd(2, "add-second-item", secondItemStatus, Date.now() - t2, secondItemNote);

    // Step 3: validate-multi-item — items>=2 OR totalQty>=2, AND minicart
    // badge >=2, AND total price strictly greater than the single-item
    // baseline captured before step 2.
    reportStart(3, "validate-multi-item");
    const t3 = Date.now();
    let multiStatus: StepCapture["status"];
    let multiNote: string | undefined;
    let multiTotals: CartTotals | undefined;
    if (secondItemStatus !== "ok") {
      multiStatus = "skipped";
      multiNote = "add-second-item não completou — nada pra validar";
    } else {
      multiTotals = await parseCartTotals(page, ctx);
      const countNow = await readCartCount(page, ctx);
      const priceNow = multiTotals.price ? parsePriceBRL(multiTotals.price) : null;
      const itemsOk = (multiTotals.items ?? 0) >= 2 || (multiTotals.totalQty ?? 0) >= 2;
      const badgeOk = countNow >= 2;
      const priceOk =
        singleItemPrice !== null && priceNow !== null ? priceNow > singleItemPrice : false;
      multiStatus = itemsOk && badgeOk && priceOk ? "ok" : "failed";
      if (multiStatus === "failed") {
        multiNote = `itemsOk=${itemsOk} badgeOk=${badgeOk}(count=${countNow}) priceOk=${priceOk}(${singleItemPrice}→${priceNow})`;
      }
    }
    steps.push({
      step: 3,
      name: "validate-multi-item",
      side: ctx.side,
      viewport: ctx.viewport,
      status: multiStatus,
      durationMs: Date.now() - t3,
      screenshotPath: screenshotPath(ctx, "cart-3-multi-item"),
      note: multiNote,
      actionDescription:
        multiStatus === "ok"
          ? `Multi-item confirmado: items=${multiTotals?.items ?? "?"}, totalQty=${multiTotals?.totalQty ?? "?"}`
          : `validate-multi-item ${multiStatus}: ${multiNote ?? ""}`,
      cartItemValidation: {
        action: "validate-multi-item",
        before: singleItemBaseline,
        after: multiTotals,
        succeeded: multiStatus === "ok",
      },
    });
    if (multiStatus !== "skipped") {
      await screenshotStable(page, { path: screenshotPath(ctx, "cart-3-multi-item") });
    }
    reportEnd(3, "validate-multi-item", multiStatus, Date.now() - t3, multiNote);

    // Step 4: read-baseline (now reflects whatever cart state we're in —
    // 1 or 2 items depending on whether add-second-item succeeded)
    reportStart(4, "read-baseline");
    const t4 = Date.now();
    const baseline = await parseCartTotals(page, ctx);
    steps.push({
      step: 4,
      name: "read-baseline",
      side: ctx.side,
      viewport: ctx.viewport,
      status: "ok",
      durationMs: Date.now() - t4,
      screenshotPath: screenshotPath(ctx, "cart-4-baseline"),
      actionDescription: `Baseline: qty=${baseline.qty ?? "?"}, price=${baseline.price ?? "?"}`,
      detail: { baseline },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-4-baseline") });
    reportEnd(4, "read-baseline", "ok", Date.now() - t4);

    // Step 5: increment-qty
    reportStart(5, "increment-qty");
    const t5 = Date.now();
    const incHit = await findElement(page, ctx, {
      key: "cartQuantityIncrement",
      intent:
        "Encontrar o botão '+' / 'aumentar quantidade' dentro de um item do carrinho aberto (minicart drawer ou /cart). Não confundir com botão de promoção/cupom.",
      budget,
      stepName: "cart-increment",
    });
    let incAfter: CartTotals = {};
    let incOk = false;
    if (incHit) {
      await incHit.locator.click({ timeout: 3_000 }).catch(() => undefined);
      incAfter = await waitForCartMutation(page, ctx, (t) => (t.qty ?? 0) > (baseline.qty ?? 0));
      incOk = (incAfter.qty ?? 0) > (baseline.qty ?? 0);
    }
    steps.push({
      step: 5,
      name: "increment-qty",
      side: ctx.side,
      viewport: ctx.viewport,
      status: incHit ? (incOk ? "ok" : "failed") : "skipped",
      durationMs: Date.now() - t5,
      screenshotPath: screenshotPath(ctx, "cart-5-increment"),
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
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-5-increment") });
    reportEnd(5, "increment-qty", incHit ? (incOk ? "ok" : "failed") : "skipped", Date.now() - t5);

    // Step 6: decrement-qty
    reportStart(6, "decrement-qty");
    const t6 = Date.now();
    const decHit = await findElement(page, ctx, {
      key: "cartQuantityDecrement",
      intent: "Encontrar o botão '-' / 'diminuir quantidade' dentro de um item do carrinho aberto.",
      budget,
      stepName: "cart-decrement",
    });
    let decAfter: CartTotals = {};
    let decOk = false;
    if (decHit) {
      await decHit.locator.click({ timeout: 3_000 }).catch(() => undefined);
      decAfter = await waitForCartMutation(
        page,
        ctx,
        (t) => (t.qty ?? 0) < (incAfter.qty ?? Number.POSITIVE_INFINITY),
      );
      decOk = (decAfter.qty ?? 0) < (incAfter.qty ?? Number.POSITIVE_INFINITY);
    }
    steps.push({
      step: 6,
      name: "decrement-qty",
      side: ctx.side,
      viewport: ctx.viewport,
      status: decHit ? (decOk ? "ok" : "failed") : "skipped",
      durationMs: Date.now() - t6,
      screenshotPath: screenshotPath(ctx, "cart-6-decrement"),
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
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-6-decrement") });
    reportEnd(6, "decrement-qty", decHit ? (decOk ? "ok" : "failed") : "skipped", Date.now() - t6);

    // Step 7: apply-invalid-coupon
    reportStart(7, "apply-invalid-coupon");
    const t7 = Date.now();
    const couponInputHit = await findElement(page, ctx, {
      key: "cartCouponInput",
      intent:
        "Encontrar o <input> de CUPOM / código promocional no carrinho aberto (placeholder costuma ser 'Digite seu cupom', 'Insira o código'). NÃO confundir com input de CEP/frete.",
      budget,
      stepName: "cart-coupon-input",
    });
    const before7 = await parseCartTotals(page, ctx);
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
        await waitForCartMutation(page, ctx, () => false, 2_000);
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
    const after7 = await parseCartTotals(page, ctx);
    const totalUnchanged = before7.price === after7.price;
    const couponStatus: StepCapture["status"] = couponInputHit
      ? couponSubmitted
        ? couponErrorShown && totalUnchanged
          ? "ok"
          : "failed"
        : "skipped"
      : "skipped";
    steps.push({
      step: 7,
      name: "apply-invalid-coupon",
      side: ctx.side,
      viewport: ctx.viewport,
      status: couponStatus,
      durationMs: Date.now() - t7,
      screenshotPath: screenshotPath(ctx, "cart-7-coupon"),
      selectorKey: "cartCouponInput",
      usedSelector: couponInputHit?.selector,
      actionDescription: couponInputHit
        ? couponSubmitted
          ? `Cupom inválido aplicado — erro visível: ${couponErrorShown}, total inalterado: ${totalUnchanged}`
          : "Coupon input encontrado, submit button ausente"
        : "Coupon input não encontrado",
      cartItemValidation: {
        action: "apply-coupon",
        before: before7,
        after: after7,
        succeeded: couponStatus === "ok",
      },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-7-coupon") });
    reportEnd(7, "apply-invalid-coupon", couponStatus, Date.now() - t7);

    // Step 8: remove-item — loop until the cart has no rows left (max 3
    // iterations) so `verify-empty-state` still passes even when the cart
    // now holds 2 items (add-second-item).
    reportStart(8, "remove-item");
    const t8 = Date.now();
    const before8 = after7;
    let removeHit = await findElement(page, ctx, {
      key: "cartRemoveItem",
      intent:
        "Encontrar o botão de REMOVER ITEM (ícone de lixeira, 'Remover', 'Excluir') dentro de um item do carrinho. Não confundir com fechar minicart drawer.",
      budget,
      stepName: "cart-remove-item",
    });
    let removed = false;
    let removeIterations = 0;
    const foundRemoveButton = !!removeHit;
    if (removeHit) {
      for (let i = 0; i < 3; i++) {
        removeIterations++;
        await removeHit.locator.click({ timeout: 3_000 }).catch(() => undefined);
        await waitForCartMutation(page, ctx, () => false, 1_800);
        const stillThere = await firstVisibleLocator(page, selFor(ctx, "cartItemRow"));
        if (!stillThere) {
          removed = true;
          break;
        }
        removeHit = await findElement(page, ctx, {
          key: "cartRemoveItem",
          intent: "Encontrar o botão de REMOVER ITEM do próximo item ainda presente no carrinho.",
          budget,
          stepName: "cart-remove-item",
        });
        if (!removeHit) break;
      }
    }
    steps.push({
      step: 8,
      name: "remove-item",
      side: ctx.side,
      viewport: ctx.viewport,
      status: foundRemoveButton ? (removed ? "ok" : "failed") : "skipped",
      durationMs: Date.now() - t8,
      screenshotPath: screenshotPath(ctx, "cart-8-remove"),
      selectorKey: "cartRemoveItem",
      usedSelector: removeHit?.selector,
      actionDescription: foundRemoveButton
        ? removed
          ? `Item(ns) removido(s) em ${removeIterations} iteração(ões) — carrinho vazio`
          : "Click no remove mas item ainda visível"
        : "Remove button não encontrado",
      cartItemValidation: {
        action: "remove",
        before: before8,
        after: { qty: removed ? 0 : (before8.qty ?? undefined) },
        succeeded: removed,
      },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-8-remove") });
    reportEnd(
      8,
      "remove-item",
      foundRemoveButton ? (removed ? "ok" : "failed") : "skipped",
      Date.now() - t8,
    );

    // Step 9: verify-empty-state
    reportStart(9, "verify-empty-state");
    const t9 = Date.now();
    const emptyText = await detectEmptyCartBanner(page);
    const emptyStatus: StepCapture["status"] = emptyText ? "ok" : removed ? "failed" : "skipped";
    steps.push({
      step: 9,
      name: "verify-empty-state",
      side: ctx.side,
      viewport: ctx.viewport,
      status: emptyStatus,
      durationMs: Date.now() - t9,
      screenshotPath: screenshotPath(ctx, "cart-9-empty"),
      actionDescription: emptyText
        ? `Empty state visível: "${emptyText.slice(0, 80)}"`
        : "Empty state não detectado",
      note: emptyText ?? undefined,
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "cart-9-empty") });
    reportEnd(9, "verify-empty-state", emptyStatus, Date.now() - t9);
  } finally {
    await page.close().catch(() => undefined);
  }

  return { pages, steps };
}
