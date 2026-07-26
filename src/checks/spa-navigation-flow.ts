import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { findFlow, isSingleSite } from "./lib/flow-pairing.ts";
import { SPA_NAVIGATION_STEP_LABELS as STEP_LABELS } from "./lib/step-names.ts";

/**
 * Step-by-step parity check for the `spa-navigation` flow (issue #54,
 * M2.5). Highest-value signal: a `verify-section-parity` failure means
 * the site drops CMS sections (site-globals, help buttons, nested
 * matched sections — issue #54's bugs 2.5/2.6/5) specifically when
 * navigated to client-side, invisible on a plain F5. Second signal:
 * hydration-classified console errors appearing during the SPA nav
 * itself (`navigate-via-spa`) — often the earlier, cheaper-to-catch
 * symptom of the same class of bug.
 *
 * Runs in both comparative (`parity run`) and single-site (`parity e2e`)
 * modes — a from-scratch migration target has no "prod" to diff against,
 * but "did sections drop after an in-app nav" is meaningful on its own.
 */
export function spaNavigationFlow(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  const single = isSingleSite(ctx.prodFlows, ctx.candFlows);

  const hasFlow =
    ctx.prodFlows.some((f) => f.flow === "spa-navigation") ||
    ctx.candFlows.some((f) => f.flow === "spa-navigation");
  if (!hasFlow) {
    return {
      name: "spa-navigation-flow",
      status: "skipped",
      severity: "critical",
      durationMs: Date.now() - start,
      summary: "spa-navigation flow não estava no escopo do run",
      issues: [],
    };
  }

  for (const viewport of ctx.viewports) {
    const prodFlow = findFlow(ctx.prodFlows, "spa-navigation", viewport);
    const candFlow = findFlow(ctx.candFlows, "spa-navigation", viewport);

    if (single) {
      const flow = prodFlow ?? candFlow;
      if (!flow) continue;
      for (const step of flow.steps ?? []) {
        if (step.name === "verify-section-parity" && step.status === "failed") {
          issues.push(sectionParityIssue(viewport, step.side, step.note, step.screenshotPath));
        }
        if (step.name === "navigate-via-spa" && step.status === "ok") {
          const hydrationCount = (step.detail?.hydrationErrorCount as number | undefined) ?? 0;
          if (hydrationCount > 0) {
            issues.push(hydrationDuringNavIssue(viewport, step.side, hydrationCount, step));
          }
        }
      }
      continue;
    }

    // Comparative mode
    const prodSteps = new Map((prodFlow?.steps ?? []).map((s) => [s.name, s]));
    const candSteps = new Map((candFlow?.steps ?? []).map((s) => [s.name, s]));

    const pSectionStep = prodSteps.get("verify-section-parity");
    const cSectionStep = candSteps.get("verify-section-parity");
    if (
      cSectionStep?.status === "failed" &&
      (pSectionStep === undefined || pSectionStep.status !== "failed")
    ) {
      issues.push(
        sectionParityIssue(viewport, "cand", cSectionStep.note, cSectionStep.screenshotPath),
      );
    }

    const pNavStep = prodSteps.get("navigate-via-spa");
    const cNavStep = candSteps.get("navigate-via-spa");
    const cHydrationCount = (cNavStep?.detail?.hydrationErrorCount as number | undefined) ?? 0;
    const pHydrationCount = (pNavStep?.detail?.hydrationErrorCount as number | undefined) ?? 0;
    if (cNavStep?.status === "ok" && cHydrationCount > 0 && pHydrationCount === 0) {
      issues.push(hydrationDuringNavIssue(viewport, "cand", cHydrationCount, cNavStep));
    }
  }

  const status: CheckResult["status"] = issues.some((i) => i.severity === "critical")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";

  return {
    name: "spa-navigation-flow",
    status,
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}

function sectionParityIssue(
  viewport: string,
  side: string,
  note: string | undefined,
  screenshotPath: string | undefined,
): Issue {
  return {
    id: `spa-navigation:${viewport}:verify-section-parity:${side}`,
    severity: "critical",
    category: "functional",
    check: "spa-navigation-flow",
    summary: `[${viewport}/${side}] "${STEP_LABELS["verify-section-parity"]}" falhou: ${note ?? "sections desapareceram após navegação SPA"}`,
    details:
      "Sections presentes num F5 da mesma URL sumiram quando a página foi alcançada via navegação client-side (SPA). " +
      "Padrão clássico de site-globals/sections carregados apenas no primeiro render (issue #54).",
    evidence: screenshotPath ? [{ kind: "screenshot", path: screenshotPath }] : [],
  };
}

function hydrationDuringNavIssue(
  viewport: string,
  side: string,
  count: number,
  step: { note?: string; screenshotPath?: string; detail?: Record<string, unknown> },
): Issue {
  const samples = (step.detail?.hydrationSamples as string[] | undefined) ?? [];
  return {
    id: `spa-navigation:${viewport}:navigate-via-spa:hydration:${side}`,
    severity: "high",
    category: "console",
    check: "spa-navigation-flow",
    summary: `[${viewport}/${side}] ${count} erro(s) de hidratação durante navegação SPA`,
    details: samples.length > 0 ? samples.join("\n") : undefined,
    evidence: step.screenshotPath ? [{ kind: "screenshot", path: step.screenshotPath }] : [],
  };
}
