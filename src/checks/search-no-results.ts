import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { buildPairEvidence, findFlow, findStep, isSingleSite } from "./lib/flow-pairing.ts";

/**
 * Validates the "no results" UI state. The harness types a deterministic
 * unicode string that cannot match any product. Cand returning >0 products
 * for that string is a CRITICAL bug — search matches anything.
 */
export function searchNoResults(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  const single = isSingleSite(ctx.prodFlows, ctx.candFlows);

  const hasSearchFlow =
    ctx.prodFlows.some((f) => f.flow === "search") ||
    ctx.candFlows.some((f) => f.flow === "search");
  if (!hasSearchFlow) {
    return {
      name: "search-no-results",
      status: "skipped",
      severity: "high",
      durationMs: Date.now() - start,
      summary: "search flow não estava no escopo do run",
      issues: [],
    };
  }

  for (const viewport of ctx.viewports) {
    const prodFlow = findFlow(ctx.prodFlows, "search", viewport);
    const candFlow = findFlow(ctx.candFlows, "search", viewport);
    const prodStep = findStep(prodFlow, "search-no-results");
    const candStep = findStep(candFlow, "search-no-results");

    const prodCount = prodStep?.searchValidation?.resultCount ?? 0;
    const candCount = candStep?.searchValidation?.resultCount ?? 0;
    const prodEmpty = prodStep?.searchValidation?.hasEmptyState ?? false;
    const candEmpty = candStep?.searchValidation?.hasEmptyState ?? false;

    if (single) {
      const step = prodStep ?? candStep;
      const count = step?.searchValidation?.resultCount ?? 0;
      const empty = step?.searchValidation?.hasEmptyState ?? false;
      // count > 0 + empty state visible → loja exibe "Não encontramos X, veja
      // estas recomendações". É padrão UX comum, não é bug.
      if (step?.status === "ok" && count > 0 && !empty) {
        // Escala por contagem:
        //  > 10 → critical (real "matcheia qualquer coisa")
        //  1-10 → medium (fuzzy fallback ou recommendations sem aviso visível)
        const isMatchEverything = count > 10;
        issues.push({
          id: `search-no-results:${viewport}:${isMatchEverything ? "matches-everything" : "fuzzy-fallback"}`,
          severity: isMatchEverything ? "critical" : "medium",
          category: "functional",
          check: "search-no-results",
          summary: isMatchEverything
            ? `[${viewport}] Termo unicode "${step.searchValidation?.term}" retornou ${count} produtos sem empty state — busca está matcheando qualquer coisa`
            : `[${viewport}] Termo unicode "${step.searchValidation?.term}" retornou ${count} produto(s) sem mensagem "nenhum resultado" — fuzzy fallback sem feedback ao usuário`,
          evidence: step.screenshotPath ? [{ kind: "screenshot", path: step.screenshotPath }] : [],
        });
      } else if (step?.status === "ok" && count === 0 && !empty) {
        issues.push({
          id: `search-no-results:${viewport}:missing-empty-state`,
          severity: "medium",
          category: "functional",
          check: "search-no-results",
          summary: `[${viewport}] Busca sem resultados não exibe mensagem "nenhum resultado" — UX prejudicada`,
        });
      }
      continue;
    }

    // Comparativo: só é bug GRAVE se cand mostra MUITOS produtos sem empty state
    // E prod não mostrou (= regressão verdadeira de matching).
    if (candCount > 0 && prodCount === 0 && !candEmpty) {
      const isMatchEverything = candCount > 10;
      issues.push({
        id: `search-no-results:${viewport}:${isMatchEverything ? "cand-matches" : "cand-fuzzy"}`,
        severity: isMatchEverything ? "critical" : "medium",
        category: "functional",
        check: "search-no-results",
        summary: isMatchEverything
          ? `[${viewport}] Termo unicode "${candStep?.searchValidation?.term}" retornou ${candCount} produtos em cand sem empty state (prod retornou 0) — bug grave de busca`
          : `[${viewport}] Termo unicode retornou ${candCount} produto(s) em cand sem empty state (prod retornou 0) — fuzzy fallback regressivo`,
        evidence: buildPairEvidence(prodStep, candStep),
      });
    }
    if (prodEmpty && !candEmpty) {
      issues.push({
        id: `search-no-results:${viewport}:missing-empty-cand`,
        severity: "medium",
        category: "functional",
        check: "search-no-results",
        summary: `[${viewport}] Empty state ausente em cand (prod exibe mensagem "nenhum resultado")`,
        evidence: buildPairEvidence(prodStep, candStep),
      });
    }
  }

  const status: CheckResult["status"] =
    issues.some((i) => i.severity === "critical")
      ? "fail"
      : issues.length > 0
        ? "warn"
        : "pass";

  return {
    name: "search-no-results",
    status,
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}
