import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

const NOT_FOUND_PATH_REGEX = /\/this-page-definitely-does-not-exist|\/__parity-404-test/i;
const NOT_FOUND_TEXT_PATTERNS = [
  /p[aá]gina n[aã]o encontrada/i,
  /not found/i,
  /404/,
  /n[aã]o encontramos/i,
  /erro 404/i,
];

/**
 * Compares 404 page behaviour. The test URL is captured by the audit
 * pipeline (or injected via `rc.notFound.testUrl`) and tagged in
 * `PageCapture.url`. This check validates:
 *  - Both sides return HTTP 404
 *  - Empty state text is present (heuristic)
 *  - Cand doesn't silently 200 on a missing route (catch-all bug)
 */
export function notFoundParity(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];

  const prodPages = ctx.prodPages.filter((p) => isNotFoundTest(p));
  const candPages = ctx.candPages.filter((p) => isNotFoundTest(p));

  if (prodPages.length === 0 && candPages.length === 0) {
    return {
      name: "not-found-parity",
      status: "skipped",
      severity: "high",
      durationMs: Date.now() - start,
      summary:
        "Nenhuma captura de URL de teste 404 — flow não capturou /this-page-... (configurar rc.notFound.testUrl)",
      issues: [],
    };
  }

  const single = prodPages.length === 0 || candPages.length === 0;
  if (single) {
    const page = prodPages[0] ?? candPages[0]!;
    if (page.status !== 404) {
      issues.push({
        id: "not-found-parity:not-404",
        severity: "critical",
        category: "functional",
        check: "not-found-parity",
        summary: `URL inválida retornou HTTP ${page.status} (esperado 404) — catch-all rota incorreta`,
        page: page.url,
      });
    }
    if (!hasNotFoundText(page)) {
      issues.push({
        id: "not-found-parity:no-message",
        severity: "medium",
        category: "functional",
        check: "not-found-parity",
        summary: "Página 404 não tem mensagem de erro reconhecível — UX prejudicada",
        page: page.url,
      });
    }
  } else {
    // Pair by viewport
    for (const viewport of ctx.viewports) {
      const p = prodPages.find((x) => x.viewport === viewport);
      const c = candPages.find((x) => x.viewport === viewport);
      if (!p || !c) continue;

      if (p.status === 404 && c.status !== 404) {
        issues.push({
          id: `not-found-parity:${viewport}:cand-not-404`,
          severity: "critical",
          category: "functional",
          check: "not-found-parity",
          summary: `[${viewport}] URL inválida retornou HTTP ${c.status} em cand (prod retornou 404) — catch-all rota incorreta`,
          page: c.url,
        });
      } else if (p.status !== 404 && c.status === 404) {
        issues.push({
          id: `not-found-parity:${viewport}:prod-not-404`,
          severity: "medium",
          category: "functional",
          check: "not-found-parity",
          summary: `[${viewport}] URL inválida retornou HTTP ${p.status} em prod (cand retornou 404) — prod pode ter catch-all 200`,
          page: p.url,
        });
      }

      const prodHasMsg = hasNotFoundText(p);
      const candHasMsg = hasNotFoundText(c);
      if (prodHasMsg && !candHasMsg) {
        issues.push({
          id: `not-found-parity:${viewport}:empty-state-missing-cand`,
          severity: "medium",
          category: "functional",
          check: "not-found-parity",
          summary: `[${viewport}] Mensagem 404 ausente em cand (prod exibe "página não encontrada")`,
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
    name: "not-found-parity",
    status,
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}

function isNotFoundTest(page: PageCapture): boolean {
  return NOT_FOUND_PATH_REGEX.test(page.url) || NOT_FOUND_PATH_REGEX.test(page.finalUrl);
}

function hasNotFoundText(page: PageCapture): boolean {
  return NOT_FOUND_TEXT_PATTERNS.some((re) => re.test(page.html));
}
