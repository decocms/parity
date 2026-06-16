import type { CheckResult, FlowCapture, Issue, StepCapture, Viewport } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

/**
 * Cart reveal mode divergence (issue #12, root fix).
 *
 * Why this check exists:
 *   `purchase-journey-flow` compares step STATUSES (ok / skipped / failed)
 *   between prod and cand, but a status compare misses a class of real
 *   regression: the minicart trigger MARKUP differs between sides, so the
 *   site behaves differently for the user even when both step 7s
 *   complete. Classic example from the miess migration:
 *   - prod: minicart trigger requires HOVER and reveals an inline drawer
 *   - cand: minicart trigger is an `<a href="/checkout">` (click navigates)
 *   On cand, the user is yanked to checkout the moment they click the cart
 *   icon — they can't see/edit their cart. That is a critical UX
 *   regression, even if `add-to-cart` and `open-minicart` both succeed.
 *
 * This check reads `StepCapture.cartRevealMode` (populated in
 *   `detectCartRevealMode` during step 7) and emits `critical` issues
 *   whenever prod and cand disagree per viewport.
 *
 * Severity:
 *   - `critical` when BOTH sides were classified and the modes disagree
 *     (the regression is real and structural).
 *   - `medium` + `inconclusive: true` when one side is `unknown`
 *     (issue #47): the heuristic classifier failed on one markup, so we
 *     can't tell if the user-visible UX actually diverges. Surfacing
 *     this as critical is a false positive — see issue #47 for the
 *     miess case where UX was identical but prod-side classification
 *     fell into the default bucket.
 */

export function cartRevealModeDivergence(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  let viewportsChecked = 0;
  let viewportsDivergent = 0;
  let viewportsInconclusive = 0;

  for (const viewport of ctx.viewports) {
    const prodMode = readMode(ctx.prodFlows, viewport);
    const candMode = readMode(ctx.candFlows, viewport);

    // No journey ran in this viewport (or step 7 didn't reach detection)
    // — skip silently; purchase-journey-flow already covers "step 7
    // didn't run" with its own severity.
    if (prodMode === null && candMode === null) continue;
    viewportsChecked++;
    if (prodMode === null || candMode === null) {
      // One side never reached step 7 → that's a regression but covered
      // by purchase-journey-flow's own issue. We only fire here when
      // BOTH sides reached step 7 and the modes disagree.
      continue;
    }
    if (prodMode === candMode) continue;

    // Issue #47: when one side classifies as "unknown" we can't confidently
    // call the divergence real. Downgrade severity + mark inconclusive so
    // the report and CI gates can de-emphasize it.
    const isInconclusive = prodMode === "unknown" || candMode === "unknown";
    if (isInconclusive) {
      viewportsInconclusive++;
      issues.push({
        id: `cart-reveal-mode:${viewport}:inconclusive`,
        severity: "medium",
        category: "functional",
        check: "cart-reveal-mode-divergence",
        inconclusive: true,
        summary: `[${viewport}] classificação cart reveal inconclusa: prod=${prodMode}, cand=${candMode} — heurística falhou em um dos lados`,
        details: inconclusiveDetail(prodMode, candMode, viewport),
      });
      continue;
    }

    viewportsDivergent++;
    issues.push({
      id: `cart-reveal-mode:${viewport}:divergent`,
      severity: "critical",
      category: "functional",
      check: "cart-reveal-mode-divergence",
      summary: `[${viewport}] minicart trigger divergente: prod=${prodMode}, cand=${candMode}${explainDivergence(prodMode, candMode)}`,
      details: detailFor(prodMode, candMode, viewport),
    });
  }

  const status: CheckResult["status"] =
    viewportsDivergent > 0
      ? "fail"
      : viewportsInconclusive > 0
        ? "warn"
        : viewportsChecked > 0
          ? "pass"
          : "skipped";

  const summaryParts: string[] = [`${viewportsChecked} viewport(s) checados`];
  if (viewportsDivergent > 0) summaryParts.push(`${viewportsDivergent} com markup divergente`);
  if (viewportsInconclusive > 0)
    summaryParts.push(`${viewportsInconclusive} inconclusivo(s) (prod=unknown ou cand=unknown)`);

  return {
    name: "cart-reveal-mode-divergence",
    status,
    severity: viewportsDivergent > 0 ? "critical" : viewportsInconclusive > 0 ? "medium" : "critical",
    durationMs: Date.now() - start,
    summary:
      viewportsChecked === 0
        ? "purchase-journey não rodou ou step 7 não classificou cart reveal mode"
        : summaryParts.join(", "),
    issues,
    data: { viewportsChecked, viewportsDivergent, viewportsInconclusive },
  };
}

function inconclusiveDetail(
  prod: NonNullable<StepCapture["cartRevealMode"]>,
  cand: NonNullable<StepCapture["cartRevealMode"]>,
  viewport: Viewport,
): string {
  const unknownSide = prod === "unknown" ? "prod" : "cand";
  return [
    `Viewport: ${viewport}`,
    `Prod cart reveal mode: ${prod}`,
    `Cand cart reveal mode: ${cand}`,
    "",
    `O classificador heurístico não conseguiu identificar o reveal mode no lado ${unknownSide}.`,
    "Isso NÃO significa que existe divergência real — apenas que a heurística não cobre o markup específico.",
    "",
    "Para confirmar se há regressão de UX:",
    "  1. Abra os screenshots pj-6 e pj-7 lado a lado em ambos viewports.",
    "  2. Verifique se o drawer abre da mesma forma após add-to-cart.",
    "  3. Se idêntico → false positive (relatar pra parity ajustar heurística).",
    "  4. Se diferente → ensine o classificador via learned-selectors.json.",
  ].join("\n");
}

function readMode(
  flows: FlowCapture[],
  viewport: Viewport,
): NonNullable<StepCapture["cartRevealMode"]> | null {
  const flow = flows.find((f) => f.flow === "purchase-journey" && f.viewport === viewport);
  if (!flow) return null;
  const step7 = flow.steps?.find((s) => s.name === "open-minicart");
  return step7?.cartRevealMode ?? null;
}

function explainDivergence(
  prod: NonNullable<StepCapture["cartRevealMode"]>,
  cand: NonNullable<StepCapture["cartRevealMode"]>,
): string {
  // Highlight the worst-case migration mistake: cand turned a drawer
  // interaction into a forced navigation.
  const candIsNav = cand === "click-navigate-checkout" || cand === "click-navigate-cart";
  const prodIsDrawer =
    prod === "hover-drawer" || prod === "click-drawer" || prod === "inline-notification";
  if (candIsNav && prodIsDrawer) {
    return " — usuário em cand é levado direto pra navegação em vez de inspecionar cart inline";
  }
  // Inverse: prod navigates, cand opens drawer — less common but still divergent.
  const prodIsNav = prod === "click-navigate-checkout" || prod === "click-navigate-cart";
  const candIsDrawer =
    cand === "hover-drawer" || cand === "click-drawer" || cand === "inline-notification";
  if (prodIsNav && candIsDrawer) {
    return " — cand expõe um drawer onde prod fazia hard navigation (ganho de UX, mas mudança de fluxo)";
  }
  return "";
}

function detailFor(
  prod: NonNullable<StepCapture["cartRevealMode"]>,
  cand: NonNullable<StepCapture["cartRevealMode"]>,
  viewport: Viewport,
): string {
  return [
    `Viewport: ${viewport}`,
    `Prod cart reveal mode: ${prod}`,
    `Cand cart reveal mode: ${cand}`,
    "",
    "Os dois lados foram exercitados pelo step 7 (open-minicart). O markup",
    "do trigger do minicart, porém, indica intenções diferentes:",
    "  - hover-drawer:          trigger reveala drawer inline ao hover",
    "  - click-drawer:          trigger tem handler de click que abre drawer inline",
    "  - click-navigate-*:      trigger é link que NAVEGA pro checkout/cart",
    "  - inline-notification:   drawer já foi aberto pelo add-to-cart",
    "",
    "Causas comuns de divergência em migração Deco Fresh→TanStack:",
    "  1. Migração trocou o elemento <a href=...> por <button> (ou vice-versa)",
    "  2. Migração removeu o data-toggle / aria-haspopup que ativava o drawer",
    "  3. Migração desmontou o handler hover-only mas manteve o link de fallback",
  ].join("\n");
}
