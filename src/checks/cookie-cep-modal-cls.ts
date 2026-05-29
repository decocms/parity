import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

const CLS_HIGH_THRESHOLD = 0.1;
const CLS_REGRESSION_RATIO = 1.5;

/**
 * Surface CLS regressions caused by late-rendered modals (cookie banners,
 * CEP/zipcode prompts, newsletter popups). The metric is taken from
 * `vitals.cls` already captured; this check pairs prod×cand and flags
 * regressions.
 *
 * Heuristic for "modal-induced CLS" vs "general CLS": the cookie/CEP/modal
 * check fires when CLS is high AND the HTML contains a dialog-like element.
 */
export function cookieCepModalCls(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];

  // Only pair captures at the same pathname+viewport (avoid noise).
  const candByKey = new Map(
    ctx.candPages.map((p) => [keyFor(p), p] as const),
  );

  for (const prod of ctx.prodPages) {
    const cand = candByKey.get(keyFor(prod));
    if (!cand) continue;
    const prodCls = prod.vitals.cls ?? 0;
    const candCls = cand.vitals.cls ?? 0;

    const hasModalProd = hasDialogLikeMarkup(prod);
    const hasModalCand = hasDialogLikeMarkup(cand);
    if (!hasModalProd && !hasModalCand) continue;

    if (candCls > CLS_HIGH_THRESHOLD && prodCls <= CLS_HIGH_THRESHOLD) {
      issues.push({
        id: `cookie-cep-cls:${cand.viewport}:introduced`,
        severity: "high",
        category: "performance",
        check: "cookie-cep-modal-cls",
        summary: `[${cand.viewport}] CLS subiu de ${prodCls.toFixed(2)} (prod) para ${candCls.toFixed(2)} (cand) em página com modal — provável regressão de banner cookies/CEP`,
        page: cand.url,
        evidence: cand.screenshotPath ? [{ kind: "screenshot", path: cand.screenshotPath }] : [],
      });
    } else if (prodCls > 0 && candCls / prodCls > CLS_REGRESSION_RATIO) {
      issues.push({
        id: `cookie-cep-cls:${cand.viewport}:worse`,
        severity: "medium",
        category: "performance",
        check: "cookie-cep-modal-cls",
        summary: `[${cand.viewport}] CLS piorou ${((candCls / prodCls - 1) * 100).toFixed(0)}%: ${prodCls.toFixed(2)} → ${candCls.toFixed(2)}`,
        page: cand.url,
      });
    }
  }

  // Single-site mode: flag any page with CLS > threshold AND modal markup.
  const isSingle = ctx.prodPages.length === 0 || ctx.candPages.length === 0;
  if (isSingle) {
    const pages = ctx.candPages.length > 0 ? ctx.candPages : ctx.prodPages;
    for (const page of pages) {
      const cls = page.vitals.cls ?? 0;
      if (cls > CLS_HIGH_THRESHOLD && hasDialogLikeMarkup(page)) {
        issues.push({
          id: `cookie-cep-cls:single:${page.viewport}:${page.url}`,
          severity: "medium",
          category: "performance",
          check: "cookie-cep-modal-cls",
          summary: `[${page.viewport}] CLS=${cls.toFixed(2)} em página com modal — banner cookies/CEP pode estar deslocando layout`,
          page: page.url,
        });
      }
    }
  }

  const status: CheckResult["status"] =
    issues.some((i) => i.severity === "critical" || i.severity === "high")
      ? "fail"
      : issues.length > 0
        ? "warn"
        : "pass";

  return {
    name: "cookie-cep-modal-cls",
    status,
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s)`,
    issues,
  };
}

function keyFor(p: PageCapture): string {
  try {
    return `${new URL(p.url).pathname}|${p.viewport}`;
  } catch {
    return `${p.url}|${p.viewport}`;
  }
}

function hasDialogLikeMarkup(page: PageCapture): boolean {
  const html = page.html.toLowerCase();
  return (
    html.includes("role=\"dialog\"") ||
    html.includes("role='dialog'") ||
    /class="[^"]*(cookie|cep|newsletter|consent)[^"]*"/i.test(page.html) ||
    /id="[^"]*(cookie|cep|newsletter|consent)[^"]*"/i.test(page.html)
  );
}
