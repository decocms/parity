import type {
  CheckResult,
  FlowCapture,
  Issue,
  PageCapture,
  ParityIgnore,
  ParityRc,
  Viewport,
} from "../types/schema.ts";
import { httpStatusParity } from "./http-status.ts";
import { consoleErrorsBaseline } from "./console-errors.ts";
import { htmlStructuralDiff } from "./html-structural.ts";
import { metaSeoParity } from "./meta-seo.ts";
import { visualRegressionKeyframes } from "./visual-regression.ts";
import { purchaseJourneyFlow } from "./purchase-journey-flow.ts";
import { networkSummaryDelta } from "./network-summary.ts";
import { webVitalsMobile } from "./web-vitals.ts";
import { imageLoadingHealth } from "./image-health.ts";
import { lazySectionPresence } from "./lazy-sections.ts";
import { seoDeepAudit } from "./seo-deep-audit.ts";

export interface CheckContext {
  /** Page captures from prod side, across all flows/viewports */
  prodPages: PageCapture[];
  /** Page captures from cand side */
  candPages: PageCapture[];
  /** Full flow captures (carries steps for purchase-journey) */
  prodFlows: FlowCapture[];
  candFlows: FlowCapture[];
  /** Resolved config */
  rc: ParityRc;
  ignore: ParityIgnore;
  /** Output dir for diff artifacts (e.g. heatmap PNGs) */
  outDir: string;
  /** Viewports under test */
  viewports: Viewport[];
}

export type Check = (ctx: CheckContext) => Promise<CheckResult> | CheckResult;

export const ALL_CHECKS: Check[] = [
  httpStatusParity,
  consoleErrorsBaseline,
  htmlStructuralDiff,
  metaSeoParity,
  visualRegressionKeyframes,
  purchaseJourneyFlow,
  networkSummaryDelta,
  webVitalsMobile,
  imageLoadingHealth,
  lazySectionPresence,
  seoDeepAudit,
];

export async function runAllChecks(ctx: CheckContext): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of ALL_CHECKS) {
    const start = Date.now();
    try {
      const r = await check(ctx);
      results.push({ ...r, durationMs: r.durationMs || Date.now() - start });
    } catch (err) {
      results.push({
        name: check.name || "anonymous-check",
        status: "fail",
        severity: "medium",
        durationMs: Date.now() - start,
        summary: `check threw: ${(err as Error).message}`,
        issues: [],
      });
    }
  }
  return results;
}

export type { Issue };
