import type { CheckResult, Issue, StepCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { buildPairEvidence, findFlow, findStep, isSingleSite } from "./lib/flow-pairing.ts";
import {
  CART_INTERACTIONS_CRITICAL_STEPS as CRITICAL_STEPS,
  CART_INTERACTIONS_STEP_LABELS as STEP_LABELS,
} from "./lib/step-names.ts";

/**
 * Step-by-step parity check for the cart-interactions flow. Critical when
 * cand fails an interaction that prod completed — typical regression after
 * migrating cart store/state management.
 */
export function cartInteractionsFlow(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  const single = isSingleSite(ctx.prodFlows, ctx.candFlows);

  const hasFlow =
    ctx.prodFlows.some((f) => f.flow === "cart-interactions") ||
    ctx.candFlows.some((f) => f.flow === "cart-interactions");
  if (!hasFlow) {
    return {
      name: "cart-interactions-flow",
      status: "skipped",
      severity: "critical",
      durationMs: Date.now() - start,
      summary: "cart-interactions flow não estava no escopo do run",
      issues: [],
    };
  }

  for (const viewport of ctx.viewports) {
    const prodFlow = findFlow(ctx.prodFlows, "cart-interactions", viewport);
    const candFlow = findFlow(ctx.candFlows, "cart-interactions", viewport);

    if (single) {
      const flow = prodFlow ?? candFlow;
      if (!flow) continue;
      for (const step of flow.steps ?? []) {
        // seller-code-null is an informational VTEX probe (issue: the
        // "digitar null no código de vendedor" trick) — it never fails
        // (status is always ok/skipped) but an anomalous cart state is
        // still worth a heads-up. Always low severity + inconclusive,
        // regardless of side/mode, and NEVER escalated.
        if (step.name === "seller-code-null" && step.note?.includes("anomalia")) {
          issues.push(sellerCodeNullAnomalyIssue(viewport, step.side, step));
          continue;
        }
        if (step.status === "failed") {
          issues.push({
            id: `cart-interactions:${viewport}:${step.name}:failed`,
            severity: CRITICAL_STEPS.has(step.name) ? "critical" : "high",
            category: "functional",
            check: "cart-interactions-flow",
            summary: `[${viewport}] Step "${STEP_LABELS[step.name] ?? step.name}" falhou: ${step.note ?? step.actionDescription ?? ""}`,
            evidence: step.screenshotPath
              ? [{ kind: "screenshot", path: step.screenshotPath }]
              : [],
          });
        }
      }
      continue;
    }

    // Comparative mode
    const prodSteps = new Map((prodFlow?.steps ?? []).map((s) => [s.name, s]));
    const candSteps = new Map((candFlow?.steps ?? []).map((s) => [s.name, s]));
    const allNames = new Set([...prodSteps.keys(), ...candSteps.keys()]);

    for (const name of allNames) {
      const p = prodSteps.get(name);
      const c = candSteps.get(name);
      if (!p || !c) continue;
      const label = STEP_LABELS[name] ?? name;

      if (name === "seller-code-null") {
        for (const step of [p, c]) {
          if (step.note?.includes("anomalia")) {
            issues.push(sellerCodeNullAnomalyIssue(viewport, step.side, step));
          }
        }
        continue;
      }

      if (p.status === "ok" && c.status === "failed") {
        // `validate-multi-item` isn't in CRITICAL_STEPS (a flaky "couldn't
        // find a second product" shouldn't hard-fail the whole flow), but
        // a cart that used to hold 2+ items on prod and can only hold 1
        // post-migration on cand IS a real regression — escalate that
        // specific comparative case to critical.
        const isMultiItemRegression = name === "validate-multi-item";
        issues.push({
          id: `cart-interactions:${viewport}:${name}:failed-cand`,
          severity: CRITICAL_STEPS.has(name) || isMultiItemRegression ? "critical" : "high",
          category: "functional",
          check: "cart-interactions-flow",
          summary: `[${viewport}] "${label}" falhou em cand (passou em prod) — ${c.note ?? c.actionDescription ?? ""}`,
          evidence: buildPairEvidence(p, c),
        });
      } else if (p.status === "ok" && c.status === "skipped") {
        issues.push({
          id: `cart-interactions:${viewport}:${name}:skipped-cand`,
          severity: CRITICAL_STEPS.has(name) ? "critical" : "medium",
          category: "functional",
          check: "cart-interactions-flow",
          summary: `[${viewport}] "${label}" foi skipado em cand mas executou em prod — selector quebrou`,
          evidence: buildPairEvidence(p, c),
        });
      }
    }
  }

  const status: CheckResult["status"] = issues.some((i) => i.severity === "critical")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";

  return {
    name: "cart-interactions-flow",
    status,
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}

/**
 * The seller-code-null probe (VTEX-only, "digitar null no código de
 * vendedor" trick) NEVER fails the run — it's a health signal, not a
 * functional assertion. An anomaly always surfaces at low severity and
 * `inconclusive: true`, on both single-site and comparative runs.
 */
function sellerCodeNullAnomalyIssue(viewport: string, side: string, step: StepCapture): Issue {
  return {
    id: `cart-interactions:${viewport}:seller-code-null:anomaly:${side}`,
    severity: "low",
    inconclusive: true,
    category: "functional",
    check: "cart-interactions-flow",
    summary: `[${viewport}/${side}] Probe VTEX seller-code=null: ${step.note}`,
    evidence: step.screenshotPath ? [{ kind: "screenshot", path: step.screenshotPath }] : [],
  };
}
