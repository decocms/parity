import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { findFlow, findStep, isSingleSite } from "./lib/flow-pairing.ts";

/**
 * Is the search input present and reachable from the home? Compares the
 * `open-search` step status across prod and cand for each viewport.
 *
 * Modes:
 *  - Comparative (run): critical if cand can't open search but prod can.
 *  - Single-site (e2e): high if search input wasn't detected at all.
 */
export function searchPresence(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  const single = isSingleSite(ctx.prodFlows, ctx.candFlows);

  const hasSearchFlow =
    ctx.prodFlows.some((f) => f.flow === "search") ||
    ctx.candFlows.some((f) => f.flow === "search");
  if (!hasSearchFlow) {
    return {
      name: "search-presence",
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
    const prodStep = findStep(prodFlow, "open-search");
    const candStep = findStep(candFlow, "open-search");

    if (single) {
      const step = prodStep ?? candStep;
      if (!step || step.status === "skipped") {
        issues.push({
          id: `search-presence:${viewport}:absent`,
          severity: "high",
          category: "functional",
          check: "search-presence",
          summary: `[${viewport}] Input de busca não foi detectado na home (${step?.note ?? "search input not found"})`,
        });
      }
      continue;
    }

    // Comparative mode
    const prodHas = prodStep?.status === "ok";
    const candHas = candStep?.status === "ok";
    if (prodHas && !candHas) {
      issues.push({
        id: `search-presence:${viewport}:missing-cand`,
        severity: "critical",
        category: "functional",
        check: "search-presence",
        summary: `[${viewport}] Search input ausente em cand mas presente em prod — busca quebrada na migração`,
        evidence: prodStep?.screenshotPath
          ? [{ kind: "screenshot", path: prodStep.screenshotPath, label: "prod" }]
          : [],
      });
    } else if (!prodHas && candHas) {
      issues.push({
        id: `search-presence:${viewport}:missing-prod`,
        severity: "medium",
        category: "functional",
        check: "search-presence",
        summary: `[${viewport}] Search input ausente em prod mas presente em cand — checar se selectors da source-of-truth estão alinhados`,
      });
    }
  }

  const status: CheckResult["status"] = issues.some((i) => i.severity === "critical")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";

  return {
    name: "search-presence",
    status,
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}
