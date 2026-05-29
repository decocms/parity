import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { buildPairEvidence, findFlow, findStep, isSingleSite } from "./lib/flow-pairing.ts";

/**
 * Does typing in the search input reveal an autocomplete dropdown with
 * product suggestions? Reads `searchValidation.suggestionCount` from the
 * `type-and-autocomplete` step.
 */
export function searchAutocomplete(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  const single = isSingleSite(ctx.prodFlows, ctx.candFlows);

  const hasSearchFlow =
    ctx.prodFlows.some((f) => f.flow === "search") ||
    ctx.candFlows.some((f) => f.flow === "search");
  if (!hasSearchFlow) {
    return {
      name: "search-autocomplete",
      status: "skipped",
      severity: "medium",
      durationMs: Date.now() - start,
      summary: "search flow não estava no escopo do run",
      issues: [],
    };
  }

  for (const viewport of ctx.viewports) {
    const prodFlow = findFlow(ctx.prodFlows, "search", viewport);
    const candFlow = findFlow(ctx.candFlows, "search", viewport);
    const prodStep = findStep(prodFlow, "type-and-autocomplete");
    const candStep = findStep(candFlow, "type-and-autocomplete");

    const prodCount = prodStep?.searchValidation?.suggestionCount ?? 0;
    const candCount = candStep?.searchValidation?.suggestionCount ?? 0;

    if (single) {
      const step = prodStep ?? candStep;
      const count = step?.searchValidation?.suggestionCount ?? 0;
      if (step && step.status === "ok" && count === 0) {
        issues.push({
          id: `search-autocomplete:${viewport}:absent`,
          severity: "medium",
          category: "functional",
          check: "search-autocomplete",
          summary: `[${viewport}] Autocomplete não retornou sugestões para o termo digitado — fluxo pode estar quebrado`,
        });
      }
      continue;
    }

    if (prodCount > 0 && candCount === 0) {
      issues.push({
        id: `search-autocomplete:${viewport}:missing-cand`,
        severity: "high",
        category: "functional",
        check: "search-autocomplete",
        summary: `[${viewport}] Autocomplete devolve ${prodCount} sugestão(ões) em prod mas 0 em cand`,
        evidence: buildPairEvidence(prodStep, candStep),
      });
    } else if (prodCount > 0 && candCount > 0) {
      const max = Math.max(prodCount, candCount);
      const delta = Math.abs(prodCount - candCount) / max;
      if (delta > 0.5) {
        issues.push({
          id: `search-autocomplete:${viewport}:count-divergence`,
          severity: "medium",
          category: "functional",
          check: "search-autocomplete",
          summary: `[${viewport}] Autocomplete: prod=${prodCount} sugestões, cand=${candCount} (delta ${(delta * 100).toFixed(0)}%)`,
          evidence: buildPairEvidence(prodStep, candStep),
        });
      }
    }
  }

  const status: CheckResult["status"] =
    issues.some((i) => i.severity === "critical")
      ? "fail"
      : issues.length > 0
        ? "warn"
        : "pass";

  return {
    name: "search-autocomplete",
    status,
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}
