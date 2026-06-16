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
import { bannerAspectRatio } from "./banner-aspect-ratio.ts";
import { cartRevealModeDivergence } from "./cart-reveal-mode.ts";
import { lazySectionPresence } from "./lazy-sections.ts";
import { cacheCoverage } from "./cache-coverage.ts";
import { seoDeepAudit } from "./seo-deep-audit.ts";
import { searchPresence } from "./search-presence.ts";
import { searchAutocomplete } from "./search-autocomplete.ts";
import { searchResults } from "./search-results.ts";
import { searchNoResults } from "./search-no-results.ts";
import { cartInteractionsFlow } from "./cart-interactions-flow.ts";
import { notFoundParity } from "./not-found-parity.ts";
import { cookieCepModalCls } from "./cookie-cep-modal-cls.ts";
import { pdpGalleryRelated } from "./pdp-gallery-related.ts";
import { footerLinksHealth } from "./footer-links-health.ts";
import { loginFlow } from "./login-flow.ts";
import { pictureMissingDims } from "./picture-missing-dims.ts";

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
  /** Output dir for diff artifacts (e.g. heatmap PNGs). Per-run. */
  outDir: string;
  /**
   * Workspace-level cache dir (cross-run). Used by visual-regression to
   * persist verdicts between `parity run` invocations so re-runs skip the
   * LLM call for screenshot pairs that already passed. When undefined,
   * caching is disabled (default for tests; populated by `run` command).
   */
  cacheDir?: string;
  /** When true, ignore any existing cache entries and re-judge from scratch. */
  noCache?: boolean;
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
  bannerAspectRatio,
  cartRevealModeDivergence,
  lazySectionPresence,
  seoDeepAudit,
  cacheCoverage,
  // Fase 2 — search + cart-interactions + site checks + login
  searchPresence,
  searchAutocomplete,
  searchResults,
  searchNoResults,
  cartInteractionsFlow,
  notFoundParity,
  cookieCepModalCls,
  pdpGalleryRelated,
  footerLinksHealth,
  loginFlow,
  pictureMissingDims,
];

/**
 * Map of kebab-case check name (as emitted by each check's `CheckResult.name`)
 * to its function. Used by `parity check <name>` (issue #31) to run a single
 * check on demand without going through the full pipeline.
 *
 * Maintained by hand so we don't pay the cost of invoking every check just
 * to read its name. If you add a check to `ALL_CHECKS` above, also register
 * it here.
 */
export const ALL_CHECKS_BY_NAME: Record<string, Check> = {
  "http-status-parity": httpStatusParity,
  "console-errors-baseline": consoleErrorsBaseline,
  "html-structural-diff": htmlStructuralDiff,
  "meta-seo-parity": metaSeoParity,
  "visual-regression-keyframes": visualRegressionKeyframes,
  "purchase-journey-flow": purchaseJourneyFlow,
  "network-summary-delta": networkSummaryDelta,
  "web-vitals-mobile": webVitalsMobile,
  "image-loading-health": imageLoadingHealth,
  "banner-aspect-ratio": bannerAspectRatio,
  "cart-reveal-mode-divergence": cartRevealModeDivergence,
  "lazy-section-presence": lazySectionPresence,
  "seo-deep-audit": seoDeepAudit,
  "cache-coverage": cacheCoverage,
  "search-presence": searchPresence,
  "search-autocomplete": searchAutocomplete,
  "search-results": searchResults,
  "search-no-results": searchNoResults,
  "cart-interactions-flow": cartInteractionsFlow,
  "not-found-parity": notFoundParity,
  "cookie-cep-modal-cls": cookieCepModalCls,
  "pdp-gallery-related": pdpGalleryRelated,
  "footer-links-health": footerLinksHealth,
  "login-flow": loginFlow,
  "picture-missing-dims": pictureMissingDims,
};

/**
 * Names of checks that REQUIRE flow captures (steps from purchase-journey).
 * `parity check` blocks these — they need to be run via `parity journey`
 * or `parity run --flows purchase-journey` instead.
 */
export const FLOW_DEPENDENT_CHECKS: ReadonlySet<string> = new Set([
  "purchase-journey-flow",
  "cart-reveal-mode-divergence",
  "search-presence",
  "search-autocomplete",
  "search-results",
  "search-no-results",
  "cart-interactions-flow",
  "login-flow",
]);

/**
 * Safe accessor for `ALL_CHECKS_BY_NAME`. Cubic flagged that a direct
 * `ALL_CHECKS_BY_NAME[userInput]` resolves prototype keys (e.g.
 * `__proto__`, `toString`) to truthy Object methods, which would bypass
 * the "check not found" branch and crash when called with a CheckContext.
 *
 * `Object.hasOwn` only matches keys WE registered, so unknown / prototype
 * keys correctly fall through to `undefined`.
 */
export function getCheckByName(name: string): Check | undefined {
  if (!Object.hasOwn(ALL_CHECKS_BY_NAME, name)) return undefined;
  return ALL_CHECKS_BY_NAME[name];
}

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
