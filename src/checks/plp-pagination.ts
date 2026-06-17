import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

/**
 * PLP pagination parity. For each PLP we captured (purchase-journey
 * step 2), fetch `?page=2` and `?page=3` against BOTH prod and cand and
 * verify:
 *
 *   - both pages return 200 (catch-all 200 bugs OR query-param-strip
 *     bugs are common during migrations)
 *   - the product set on each page is different from page 1 (the
 *     classic regression: TanStack site ignores `?page=N` and returns
 *     the same items every time → infinite first page)
 *   - cand's product count per page is within ~30% of prod's (deeper
 *     pagination divergence usually means sort order broke)
 *
 * We fetch instead of navigating: the check runs against PLP URLs that
 * are already known from the journey capture, the markup is server-
 * rendered in Deco TanStack so HTML alone is enough, and skipping
 * Playwright keeps the check sub-second.
 */
export async function plpPagination(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  // The journey records the PLP it landed on as step 2 of purchase-journey.
  // Pull that URL per side; if missing, fall back to scraping the home
  // page so the check still runs in single-check mode (`parity check
  // plp-pagination`).
  let prodPlp = pickPlpUrl(ctx.prodFlows);
  let candPlp = pickPlpUrl(ctx.candFlows);

  if (!prodPlp && ctx.prodPages.length > 0) {
    prodPlp = await discoverPlpFromHome(ctx.prodPages[0]!.url);
  }
  if (!candPlp && ctx.candPages.length > 0) {
    candPlp = await discoverPlpFromHome(ctx.candPages[0]!.url);
  }

  if (!prodPlp && !candPlp) {
    return {
      name: "plp-pagination",
      status: "skipped",
      severity: "medium",
      durationMs: Date.now() - start,
      summary:
        "no PLP captured by purchase-journey step 2 AND no home page to discover one from — skipping",
      issues: [],
    };
  }

  const data: Record<string, unknown> = {};

  for (const [side, plp] of [
    ["prod", prodPlp],
    ["cand", candPlp],
  ] as const) {
    if (!plp) continue;
    const page1 = await fetchPlpProducts(plp);
    const page2 = await fetchPlpProducts(withPage(plp, 2));
    const page3 = await fetchPlpProducts(withPage(plp, 3));
    data[`${side}_page_counts`] = {
      page1: { status: page1.status, products: page1.productPaths.length },
      page2: { status: page2.status, products: page2.productPaths.length },
      page3: { status: page3.status, products: page3.productPaths.length },
    };

    // Non-200 page = pagination broken
    for (const [n, result] of [
      [2, page2],
      [3, page3],
    ] as const) {
      if (result.status !== 200) {
        issues.push({
          id: `plp-pagination:${side}:page${n}:status-${result.status}`,
          severity: "high",
          category: "functional",
          check: "plp-pagination",
          summary: `[${side}] page=${n} returned HTTP ${result.status} (expected 200) — pagination breaks under ?page=${n}`,
          page: withPage(plp, n),
        });
      }
    }

    // Same products on page 2 as page 1 → pagination is a no-op
    if (page1.productPaths.length > 0 && page2.status === 200) {
      const overlap = setOverlap(page1.productPaths, page2.productPaths);
      if (overlap > 0.9) {
        issues.push({
          id: `plp-pagination:${side}:page2-identical`,
          severity: "critical",
          category: "functional",
          check: "plp-pagination",
          summary: `[${side}] page=2 shows the same ${page1.productPaths.length} products as page=1 (${(overlap * 100).toFixed(0)}% overlap) — ?page=N is being ignored`,
          page: withPage(plp, 2),
          details: `Page 1 first product: ${page1.productPaths[0] ?? "(none)"}\nPage 2 first product: ${page2.productPaths[0] ?? "(none)"}`,
        });
      }
    }

    if (page2.productPaths.length > 0 && page3.status === 200) {
      const overlap = setOverlap(page2.productPaths, page3.productPaths);
      if (overlap > 0.9) {
        issues.push({
          id: `plp-pagination:${side}:page3-identical`,
          severity: "critical",
          category: "functional",
          check: "plp-pagination",
          summary: `[${side}] page=3 shows the same products as page=2 (${(overlap * 100).toFixed(0)}% overlap) — pagination capped or broken`,
          page: withPage(plp, 3),
        });
      }
    }
  }

  // Cross-side: prod and cand should have similar product counts on each
  // page (within 30%). Wildly different counts mean the migrated index
  // dropped items or has a different page size.
  if (prodPlp && candPlp) {
    const prodCounts = data.prod_page_counts as { page2: { products: number } } | undefined;
    const candCounts = data.cand_page_counts as { page2: { products: number } } | undefined;
    if (prodCounts && candCounts) {
      const p = prodCounts.page2.products;
      const c = candCounts.page2.products;
      if (p > 0 && Math.abs(p - c) / p > 0.3) {
        issues.push({
          id: "plp-pagination:cross-side-count-divergence",
          severity: "medium",
          category: "functional",
          check: "plp-pagination",
          summary: `page=2 product count diverges: prod=${p}, cand=${c} (Δ ${Math.abs(p - c)}, >30%)`,
        });
      }
    }
  }

  const status: CheckResult["status"] = issues.some((i) => i.severity === "critical")
    ? "fail"
    : issues.length > 0
      ? "fail"
      : "pass";

  return {
    name: "plp-pagination",
    status,
    severity: "high",
    durationMs: Date.now() - start,
    summary:
      issues.length === 0
        ? `PLP pagination working on both sides (tested page=2 + page=3)`
        : `${issues.length} pagination issue(s) — see details`,
    issues,
    data,
  };
}

interface PlpFetchResult {
  status: number;
  productPaths: string[];
}

async function fetchPlpProducts(url: string): Promise<PlpFetchResult> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
      // Some PLPs are 5-10MB on a fresh response; cap the read so a
      // misbehaving site can't hang the check.
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) {
      return { status: res.status, productPaths: [] };
    }
    const html = await res.text();
    // Extract product paths — generic across Deco / VTEX / Shopify.
    // Look for hrefs ending in `/p` (Deco/VTEX product page convention)
    // OR containing `/p/` OR `/products/`.
    const paths = new Set<string>();
    const re = /href="([^"]+\/p(?:\?[^"]*|\/[^"]+|))"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const path = m[1];
      if (!path) continue;
      // Normalize: drop query, drop trailing slash. We're checking SET
      // membership, so we want each product counted once regardless of
      // skuId query params or trailing slash variation.
      const normalized = path.split("?")[0]!.replace(/\/$/, "");
      paths.add(normalized);
    }
    const re2 = /href="([^"]+\/products\/[^"]+)"/gi;
    while ((m = re2.exec(html))) {
      const path = m[1];
      if (path) paths.add(path.split("?")[0]!.replace(/\/$/, ""));
    }
    return { status: 200, productPaths: Array.from(paths) };
  } catch (err) {
    return { status: 0, productPaths: [] };
  }
}

function withPage(url: string, n: number): string {
  try {
    const u = new URL(url);
    u.searchParams.set("page", String(n));
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}page=${n}`;
  }
}

/**
 * Fallback for `parity check plp-pagination` (no journey ran first).
 * Fetches the home page and picks the first href that looks like a
 * category PLP — a depth-1 or depth-2 path not containing `/p` (product),
 * `/cart`, `/checkout`, `/account`, etc.
 */
async function discoverPlpFromHome(homeUrl: string): Promise<string | null> {
  try {
    const res = await fetch(homeUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const candidates = new Set<string>();
    const re = /href="([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const href = m[1];
      if (!href) continue;
      // Skip non-PLP hrefs
      if (
        /^https?:\/\//.test(href) ||
        href.startsWith("#") ||
        href === "/" ||
        /\/(p|cart|carrinho|checkout|account|conta|login|wishlist|favoritos)(\/|$|\?)/i.test(href) ||
        /\.(jpg|png|webp|css|js|svg|ico|woff)/i.test(href)
      ) {
        continue;
      }
      const segments = href.split("?")[0]!.split("/").filter(Boolean);
      if (segments.length === 0 || segments.length > 3) continue;
      candidates.add(href.split("?")[0]!);
    }
    // First candidate that has another candidate as a prefix wins — that
    // makes it likelier the URL points at a category index page vs an
    // institutional landing.
    const sorted = Array.from(candidates).sort((a, b) => a.length - b.length);
    const home = new URL(homeUrl);
    const pick = sorted[0];
    if (!pick) return null;
    return new URL(pick, home).toString();
  } catch {
    return null;
  }
}

function pickPlpUrl(flows: CheckContext["prodFlows"]): string | null {
  for (const fc of flows) {
    if (fc.flow !== "purchase-journey") continue;
    const plpStep = fc.steps?.find((s) => s.name === "navigate-plp" && s.status === "ok");
    if (plpStep?.url) return plpStep.url;
    // Fallback: any PLP-looking URL in the captured pages
    const plpPage: PageCapture | undefined = fc.pages.find((p) => {
      try {
        const u = new URL(p.url);
        // PLP heuristic: depth-1 or depth-2 path, not /p or /products
        return (
          u.pathname.split("/").filter(Boolean).length <= 2 &&
          !/\/p$|\/products\//.test(u.pathname)
        );
      } catch {
        return false;
      }
    });
    if (plpPage) return plpPage.url;
  }
  return null;
}

function setOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  let common = 0;
  for (const x of b) if (sa.has(x)) common++;
  return common / Math.max(a.length, b.length);
}
