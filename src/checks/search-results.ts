import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { buildPairEvidence, findFlow, findStep, isSingleSite } from "./lib/flow-pairing.ts";

const RESULTS_DELTA_THRESHOLD = 0.3; // 30% delta = high

/**
 * Compares product result counts when submitting the same `withResults`
 * search term. Critical when cand returns 0 results for a term that
 * worked in prod — search index broke during migration.
 */
export function searchResults(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  const single = isSingleSite(ctx.prodFlows, ctx.candFlows);

  const hasSearchFlow =
    ctx.prodFlows.some((f) => f.flow === "search") ||
    ctx.candFlows.some((f) => f.flow === "search");
  if (!hasSearchFlow) {
    return {
      name: "search-results",
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
    const prodStep = findStep(prodFlow, "submit-results");
    const candStep = findStep(candFlow, "submit-results");

    const prodCount = prodStep?.searchValidation?.resultCount ?? 0;
    const candCount = candStep?.searchValidation?.resultCount ?? 0;

    if (single) {
      const step = prodStep ?? candStep;
      const count = step?.searchValidation?.resultCount ?? 0;
      if (step && step.status === "ok" && count === 0) {
        issues.push({
          id: `search-results:${viewport}:empty`,
          severity: "high",
          category: "functional",
          check: "search-results",
          summary: `[${viewport}] Busca submetida não retornou nenhum produto — índice de busca pode estar quebrado`,
          evidence: step.screenshotPath ? [{ kind: "screenshot", path: step.screenshotPath }] : [],
        });
      }
      continue;
    }

    if (prodCount > 0 && candCount === 0) {
      issues.push({
        id: `search-results:${viewport}:cand-zero`,
        severity: "critical",
        category: "functional",
        check: "search-results",
        summary: `[${viewport}] Cand retornou 0 produtos para "${prodStep?.searchValidation?.term ?? ""}" (prod retornou ${prodCount}) — busca quebrada`,
        evidence: buildPairEvidence(prodStep, candStep),
      });
    } else if (prodCount > 0 && candCount > 0) {
      const max = Math.max(prodCount, candCount);
      const delta = Math.abs(prodCount - candCount) / max;
      if (delta > RESULTS_DELTA_THRESHOLD) {
        issues.push({
          id: `search-results:${viewport}:count-divergence`,
          severity: "high",
          category: "functional",
          check: "search-results",
          summary: `[${viewport}] Counts divergem >${RESULTS_DELTA_THRESHOLD * 100}%: prod=${prodCount}, cand=${candCount} (delta ${(delta * 100).toFixed(0)}%)`,
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
    name: "search-results",
    status,
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}
