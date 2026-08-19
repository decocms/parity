import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { hasAnyBreadcrumbSignal } from "./lib/breadcrumb-detect.ts";

const PDP_PATH_REGEX = /\/p\/|\/products?\//i;

/**
 * PDP breadcrumb presence/parity. Operates on ALREADY-CAPTURED PDP page
 * HTML (whatever flow — purchase-journey, pdp — already ran and put PDP
 * pages in `ctx.prodPages` / `ctx.candPages`), so this check is pure/fast
 * and needs zero extra browser time. NOT flow-dependent: it just needs a
 * PDP page to already be in scope, which happens whenever purchase-journey
 * or the standalone `pdp` flow ran.
 *
 * Detects breadcrumbs via two independent signals (either is enough):
 *   - markup: `nav[aria-label*="breadcrumb"]` / `[class*="breadcrumb"]` /
 *     `[data-breadcrumb]`
 *   - structured data: a schema.org `BreadcrumbList` JSON-LD block
 *
 * A prod page with breadcrumbs whose cand counterpart has neither signal
 * is a real regression — it hurts both UX (no trail to navigate up) and
 * SEO (rich-result breadcrumbs disappear from search listings).
 */
export function pdpBreadcrumbs(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];

  const prodPdps = ctx.prodPages.filter(isPdp);
  const candPdps = ctx.candPages.filter(isPdp);
  if (prodPdps.length === 0 && candPdps.length === 0) {
    return {
      name: "pdp-breadcrumbs",
      status: "skipped",
      severity: "medium",
      durationMs: Date.now() - start,
      summary: "Nenhuma captura de PDP no run",
      issues: [],
    };
  }

  const single = prodPdps.length === 0 || candPdps.length === 0;
  const sourcePages = single ? (candPdps.length > 0 ? candPdps : prodPdps) : candPdps;

  for (const page of sourcePages) {
    const pair = single ? undefined : prodPdps.find((p) => p.viewport === page.viewport);
    const candHas = hasAnyBreadcrumbSignal(page.html);

    if (single) {
      if (!candHas) {
        issues.push({
          id: `pdp-breadcrumbs:${page.viewport}:missing`,
          severity: "medium",
          category: "seo",
          check: "pdp-breadcrumbs",
          summary: `[${page.viewport}] PDP sem breadcrumbs detectáveis (nem markup, nem JSON-LD BreadcrumbList) — ${page.url}`,
          page: page.url,
        });
      }
    } else if (pair) {
      const prodHas = hasAnyBreadcrumbSignal(pair.html);
      if (prodHas && !candHas) {
        issues.push({
          id: `pdp-breadcrumbs:${page.viewport}:lost`,
          severity: "medium",
          category: "seo",
          check: "pdp-breadcrumbs",
          summary: `[${page.viewport}] Breadcrumbs ausentes em cand (presentes em prod) — impacto em UX e em SEO estruturado (rich results)`,
          page: page.url,
        });
      }
    }
  }

  const status: CheckResult["status"] = issues.length > 0 ? "warn" : "pass";

  return {
    name: "pdp-breadcrumbs",
    status,
    severity: "medium",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}

function isPdp(page: PageCapture): boolean {
  return PDP_PATH_REGEX.test(page.url);
}
