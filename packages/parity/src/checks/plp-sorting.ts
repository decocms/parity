import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { extractOrderedProductHrefs, sortOrderChanged } from "./lib/plp-sort-order.ts";
import { discoverPlpFromHome, pickPlpUrl } from "./plp-pagination.ts";

/**
 * PLP sort parity — fetch-based, no Playwright (mirrors `plp-pagination.ts`).
 *
 * For each side's PLP, fetch the default listing and one sort-variant
 * listing, then compare product ORDER (not just the set, like
 * `plp-pagination` does for page-N overlap). If the "sorted" variant's
 * product order is byte-for-byte identical to the default listing, sorting
 * silently didn't apply — a common regression where the sort query param
 * gets dropped/ignored during a migration.
 *
 * v1 is intentionally scrappy (lower priority than persistence/breadcrumbs):
 * we try two common sort-query conventions (`?sort=price-asc` — generic/
 * Deco convention — and `?orderBy=OrderByPriceASC` — VTEX convention) and
 * use whichever one actually returns a non-empty, 200 product list. We
 * don't attempt to verify the sort is semantically CORRECT (e.g. actually
 * ascending by price) — only that applying a sort param changes the
 * rendered order at all.
 */
export async function plpSorting(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  const prodPlp = await resolvePlpUrl(ctx.prodFlows, ctx.prodPages);
  const candPlp = await resolvePlpUrl(ctx.candFlows, ctx.candPages);

  if (!prodPlp && !candPlp) {
    return {
      name: "plp-sorting",
      status: "skipped",
      severity: "medium",
      durationMs: Date.now() - start,
      summary: "no PLP captured by purchase-journey AND no home page to discover one from",
      issues: [],
    };
  }

  const data: Record<string, unknown> = {};
  const applied: Record<"prod" | "cand", boolean | null> = { prod: null, cand: null };

  for (const [side, plp] of [
    ["prod", prodPlp],
    ["cand", candPlp],
  ] as const) {
    if (!plp) continue;
    const base = await fetchOrderedHrefs(plp);
    if (base.status !== 200 || base.hrefs.length === 0) {
      data[`${side}_sort_applied`] = null;
      continue;
    }
    let sortApplied: boolean | null = null;
    for (const variant of SORT_QUERY_VARIANTS) {
      const sorted = await fetchOrderedHrefs(withQuery(plp, variant));
      if (sorted.status !== 200 || sorted.hrefs.length === 0) continue;
      const changed = sortOrderChanged(base.hrefs, sorted.hrefs);
      if (changed) {
        sortApplied = true;
        break;
      }
      sortApplied = false; // at least one variant fetched fine but didn't reorder
    }
    applied[side] = sortApplied;
    data[`${side}_sort_applied`] = sortApplied;
  }

  if (applied.prod !== null && applied.cand !== null && applied.prod !== applied.cand) {
    issues.push({
      id: "plp-sorting:divergence",
      severity: "medium",
      category: "functional",
      check: "plp-sorting",
      summary: `Ordenação de PLP diverge entre os lados: prod ${applied.prod ? "aplicou" : "NÃO aplicou"} o sort, cand ${applied.cand ? "aplicou" : "NÃO aplicou"} — parâmetro de sort pode ter sido perdido/ignorado na migração`,
      page: candPlp ?? prodPlp ?? undefined,
    });
  }

  const status: CheckResult["status"] = issues.length > 0 ? "warn" : "pass";

  return {
    name: "plp-sorting",
    status,
    severity: "medium",
    durationMs: Date.now() - start,
    summary:
      issues.length === 0
        ? "Sort behavior consistent (or untestable) on both sides"
        : `${issues.length} issue(s) — see details`,
    issues,
    data,
  };
}

const SORT_QUERY_VARIANTS = ["sort=price-asc", "orderBy=OrderByPriceASC"];

interface OrderedFetchResult {
  status: number;
  hrefs: string[];
}

async function fetchOrderedHrefs(url: string): Promise<OrderedFetchResult> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) return { status: res.status, hrefs: [] };
    const html = await res.text();
    return { status: 200, hrefs: extractOrderedProductHrefs(html) };
  } catch {
    return { status: 0, hrefs: [] };
  }
}

function withQuery(url: string, queryStr: string): string {
  try {
    const u = new URL(url);
    const [k, v] = queryStr.split("=");
    if (k) u.searchParams.set(k, v ?? "");
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${queryStr}`;
  }
}

async function resolvePlpUrl(
  flows: CheckContext["prodFlows"],
  pages: CheckContext["prodPages"],
): Promise<string | null> {
  const fromFlow = pickPlpUrl(flows);
  if (fromFlow) return fromFlow;
  if (pages.length > 0) return await discoverPlpFromHome(pages[0]!.url);
  return null;
}
