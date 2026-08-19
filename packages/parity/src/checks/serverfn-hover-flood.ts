import type { CheckResult, Issue, StepCapture, Viewport } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { findFlow } from "./lib/flow-pairing.ts";
import { DEFAULT_SERVERFN_FLOOD_BUDGET, evaluateHoverFloodBudget } from "./lib/serverfn-flood.ts";

/**
 * `hover-preload-budget` data reader (issue #54, 3/D). TanStack's
 * `preload="intent"` fires a `_serverFn` request per hovered `<Link>` —
 * on a PLP with a handful of product cards this can flood the worker
 * (30+ concurrent requests observed in the Bagaggio migration). The data
 * is collected by a step folded into `flowPlp` (`hover-preload-budget`,
 * see `src/engine/flows/simple.ts`); this check just reads the recorded
 * count and applies the configurable budget.
 *
 * Meaningful mostly on the cand/single-site side — a Fresh (or any
 * non-TanStack-Start) prod site will simply never match the server-fn
 * pattern, so the step records 0 and this check degrades gracefully to
 * `skipped` rather than a false pass/fail.
 */
export function serverFnHoverFlood(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  const budget = ctx.rc.serverFnFloodBudget ?? DEFAULT_SERVERFN_FLOOD_BUDGET;

  const hasFlow =
    ctx.prodFlows.some((f) => f.flow === "plp") || ctx.candFlows.some((f) => f.flow === "plp");
  if (!hasFlow) {
    return {
      name: "serverfn-hover-flood",
      status: "skipped",
      severity: "high",
      durationMs: Date.now() - start,
      summary: "plp flow não estava no escopo do run",
      issues: [],
    };
  }

  let anyMeasured = false;
  for (const viewport of ctx.viewports) {
    for (const side of ["prod", "cand"] as const) {
      const flows = side === "prod" ? ctx.prodFlows : ctx.candFlows;
      const flow = findFlow(flows, "plp", viewport as Viewport);
      const step = flow?.steps?.find((s) => s.name === "hover-preload-budget");
      if (!step || step.status === "skipped") continue;
      anyMeasured = true;
      const count = readCount(step);
      const result = evaluateHoverFloodBudget(count, budget);
      if (result.exceeded) {
        issues.push({
          id: `serverfn-hover-flood:${viewport}:${side}`,
          severity: "high",
          category: "network",
          check: "serverfn-hover-flood",
          summary: `[${viewport}/${side}] ${count} request(s) "${step.detail?.pattern ?? "_serverFn"}" disparadas ao hover em product cards (budget=${budget})`,
          details:
            "Hover em product cards disparou mais requests de server-fn / preload do que o orçamento configurado — " +
            'sinal do padrão `preload="intent"` do TanStack Start floodando o worker (issue #54).',
          evidence: step.screenshotPath ? [{ kind: "screenshot", path: step.screenshotPath }] : [],
        });
      }
    }
  }

  if (!anyMeasured) {
    return {
      name: "serverfn-hover-flood",
      status: "skipped",
      severity: "high",
      durationMs: Date.now() - start,
      summary:
        "hover-preload-budget step não coletou dados (sem product cards, ou padrão nunca matched)",
      issues: [],
    };
  }

  return {
    name: "serverfn-hover-flood",
    status: issues.length > 0 ? "warn" : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} divergência(s) de orçamento de server-fn no hover`,
    issues,
  };
}

function readCount(step: StepCapture): number {
  const v = step.detail?.serverFnRequestCount;
  return typeof v === "number" ? v : 0;
}
