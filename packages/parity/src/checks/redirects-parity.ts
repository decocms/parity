import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

/**
 * Redirect DESTINATION parity. `http-status-parity` already catches a status
 * code mismatch (200 vs 404, etc.), but two pages that both redirect and both
 * end up on some 200 page still pass that check even when they redirect to
 * DIFFERENT destinations — the classic way a migration silently breaks a
 * legacy-URL redirect table and loses accumulated SEO ranking on paths that
 * "still work" (200, just the wrong page).
 *
 * Uses `PageCapture.url` (requested) vs `.finalUrl` (after following
 * redirects) — both already captured, no new capture-side work. Compares
 * PATHS only (query/hash stripped, host ignored) so a prod→cand domain
 * change alone never counts as a destination mismatch.
 */
export function redirectsParity(ctx: CheckContext): CheckResult {
  const start = Date.now();
  if (ctx.prodPages.length === 0) {
    return skip(start, "sem baseline prod — nada para comparar (single-site)");
  }

  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];
  let redirectsChecked = 0;

  for (const pair of pairs) {
    const prodRedirected = didRedirect(pair.prod.url, pair.prod.finalUrl);
    if (!prodRedirected) continue; // this check only concerns pages prod redirects
    redirectsChecked++;

    const candRedirected = didRedirect(pair.cand.url, pair.cand.finalUrl);
    if (!candRedirected) {
      issues.push({
        id: `redirect:not-preserved:${pair.key}`,
        severity: "high",
        category: "seo",
        page: pair.key,
        check: "redirects-parity",
        summary: `prod redireciona ${pair.key} para ${pathOf(pair.prod.finalUrl)}, candidato não redireciona (serve o próprio caminho)`,
        suggestedFix:
          "Confirme se a tabela de redirects legada foi migrada para este caminho.",
      });
      continue;
    }

    const prodDest = pathOf(pair.prod.finalUrl);
    const candDest = pathOf(pair.cand.finalUrl);
    if (prodDest !== candDest) {
      issues.push({
        id: `redirect:destination-diff:${pair.key}`,
        severity: "medium",
        category: "seo",
        page: pair.key,
        check: "redirects-parity",
        summary: `Destino de redirect diverge em ${pair.key}: prod→${prodDest} cand→${candDest}`,
        inconclusive: true, // both sides are "valid" redirects — flag for a human to confirm intent
      });
    }
  }

  return {
    name: "redirects-parity",
    status: issues.some((i) => i.severity === "high")
      ? "fail"
      : issues.length > 0
        ? "warn"
        : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary:
      redirectsChecked === 0
        ? "prod não redirecionou nenhuma das páginas capturadas — nada a validar"
        : `${redirectsChecked} redirect(s) de prod verificado(s), ${issues.length} divergência(s)`,
    issues,
  };
}

function didRedirect(requested: string, final: string): boolean {
  if (!requested || !final) return false;
  return pathOf(requested) !== pathOf(final);
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return url;
  }
}

function skip(start: number, summary: string): CheckResult {
  return {
    name: "redirects-parity",
    status: "skipped",
    severity: "high",
    durationMs: Date.now() - start,
    summary,
    issues: [],
  };
}
