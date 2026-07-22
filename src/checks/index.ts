import type {
  CheckResult,
  FlowCapture,
  Issue,
  PageCapture,
  ParityIgnore,
  ParityRc,
  Viewport,
} from "../types/schema.ts";
import { bannerAspectRatio } from "./banner-aspect-ratio.ts";
import { cacheCoverage } from "./cache-coverage.ts";
import { cartInteractionsFlow } from "./cart-interactions-flow.ts";
import { cartRevealModeDivergence } from "./cart-reveal-mode.ts";
import { consoleErrorsBaseline } from "./console-errors.ts";
import { cookieCepModalCls } from "./cookie-cep-modal-cls.ts";
import { footerLinksHealth } from "./footer-links-health.ts";
import { htmlStructuralDiff } from "./html-structural.ts";
import { httpStatusParity } from "./http-status.ts";
import { imageLoadingHealth } from "./image-health.ts";
import { lazySectionPresence } from "./lazy-sections.ts";
import { loginFlow } from "./login-flow.ts";
import { metaSeoParity } from "./meta-seo.ts";
import { networkSummaryDelta } from "./network-summary.ts";
import { notFoundParity } from "./not-found-parity.ts";
import { pdpBreadcrumbs } from "./pdp-breadcrumbs.ts";
import { pdpGalleryRelated } from "./pdp-gallery-related.ts";
import { pictureMissingDims } from "./picture-missing-dims.ts";
import { plpPagination } from "./plp-pagination.ts";
import { plpSorting } from "./plp-sorting.ts";
import { purchaseJourneyFlow } from "./purchase-journey-flow.ts";
import { searchAutocomplete } from "./search-autocomplete.ts";
import { searchNoResults } from "./search-no-results.ts";
import { searchPresence } from "./search-presence.ts";
import { searchResults } from "./search-results.ts";
import { seoDeepAudit } from "./seo-deep-audit.ts";
import { visualRegressionKeyframes } from "./visual-regression.ts";
import { webVitalsMobile } from "./web-vitals.ts";

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
  plpPagination,
  pdpBreadcrumbs,
  plpSorting,
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
  "plp-pagination": plpPagination,
  "pdp-breadcrumbs": pdpBreadcrumbs,
  "plp-sorting": plpSorting,
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

/**
 * Run every check in parallel and return the results array.
 *
 * Almost every check (~24 of 27) is a pure aggregation over already-
 * captured `PageCapture[]` / `FlowCapture[]` data — string/HTML diffs,
 * regex matches, console-entry filtering. Three issue raw network
 * fetches (`seo-deep-audit`, `footer-links-health`, `plp-pagination`)
 * but those are I/O-bound, not CPU-bound, so they parallelize cleanly
 * with the pure-aggregation checks too. Running them sequentially used
 * ~4.5min of an end-to-end run; in parallel the whole phase is dominated
 * by the slowest single check.
 *
 * `outResults`, if provided, is the SAME array that gets populated as
 * each check completes — callers (e.g. `runCommand`'s shutdown path)
 * hold a reference to it so a SIGINT/timeout mid-pipeline still has
 * access to whatever checks finished before the interrupt. The push
 * happens in the per-check `.then()` so ordering reflects completion
 * order, not declaration order. Review feedback on PR #59.
 */
export async function runAllChecks(
  ctx: CheckContext,
  outResults?: CheckResult[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = outResults ?? [];
  await Promise.all(
    ALL_CHECKS.map(async (check) => {
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
    }),
  );
  return results;
}

export type { Issue };
