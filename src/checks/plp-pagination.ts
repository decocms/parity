import type { CheckResult, FlowCapture, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { hrefOverlap } from "./lib/pagination-overlap.ts";

/**
 * PLP pagination parity.
 *
 * Two complementary sources of evidence feed this check:
 *
 *  1. INTERACTIVE (preferred, when available): the `plp` flow
 *     (`engine/flows/simple.ts`) drives the page like a user would —
 *     clicking a "next page" link, clicking "load more", or scrolling —
 *     and records `detect-pagination-mode` / `paginate` / `verify-pagination`
 *     steps. This is the only way to catch "load more" and infinite-scroll
 *     sites correctly; a `?page=N` fetch against those is meaningless (the
 *     server ignores the param by design, not by bug).
 *
 *  2. FETCH-BASED FALLBACK (cheap, always available in single-check mode):
 *     fetch `?page=2` / `?page=3` against BOTH prod and cand and verify
 *     both return 200, the product set differs from page 1, and cross-side
 *     counts are within ~30%. This is the classic "TanStack site ignores
 *     ?page=N" detector. It's only TRUSTED for a side when that side's
 *     interactive mode is "page-link", "none"/unknown, or when no `plp`
 *     flow ran at all — fetching `?page=2` against a load-more/infinite-
 *     scroll site is a known false-positive source (issue: M2 roadmap).
 */
export async function plpPagination(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  const prodStep = pickPlpStepData(ctx.prodFlows);
  const candStep = pickPlpStepData(ctx.candFlows);

  if (prodStep && candStep) {
    const prodPaginates = prodStep.verifyStatus === "ok";
    if (prodPaginates && (candStep.mode === "none" || candStep.verifyStatus === "failed")) {
      issues.push({
        id: "plp-pagination:interactive:cand-broken",
        severity: "critical",
        category: "functional",
        check: "plp-pagination",
        summary:
          candStep.mode === "none"
            ? `[cand] prod paginates interactively (mode="${prodStep.mode}") but cand shows no pagination affordance at all`
            : `[cand] prod paginates interactively (mode="${prodStep.mode}") but cand's pagination action (mode="${candStep.mode}") failed verification`,
        details: `prod verify-pagination: ${JSON.stringify(prodStep.detail ?? {})}\ncand verify-pagination: ${JSON.stringify(candStep.detail ?? {})}`,
      });
    } else if (
      prodStep.mode !== "unknown" &&
      candStep.mode !== "unknown" &&
      prodStep.mode !== candStep.mode
    ) {
      issues.push({
        id: "plp-pagination:interactive:mode-changed",
        severity: "medium",
        category: "functional",
        check: "plp-pagination",
        summary: `pagination mode changed: prod="${prodStep.mode}" → cand="${candStep.mode}" — could be an intentional redesign, not necessarily a bug`,
        inconclusive: true,
      });
    }
  }

  // The journey records the PLP it landed on as step 2 of purchase-journey
  // (or, now, as the second page of the `plp` flow itself). Pull that URL
  // per side; if missing, fall back to scraping the home page so the check
  // still runs in single-check mode (`parity check plp-pagination`).
  let prodPlp = pickPlpUrl(ctx.prodFlows);
  let candPlp = pickPlpUrl(ctx.candFlows);

  if (!prodPlp && ctx.prodPages.length > 0) {
    prodPlp = await discoverPlpFromHome(ctx.prodPages[0]!.url);
  }
  if (!candPlp && ctx.candPages.length > 0) {
    candPlp = await discoverPlpFromHome(ctx.candPages[0]!.url);
  }

  if (!prodPlp && !candPlp) {
    // Even with no URL to fetch against, the interactive flow may have
    // already produced issues above (e.g. it ran plp-only, no purchase-
    // journey, and captured verify-pagination data straight from steps).
    if (issues.length > 0) {
      return {
        name: "plp-pagination",
        status: "fail",
        severity: "high",
        durationMs: Date.now() - start,
        summary: `${issues.length} pagination issue(s) from interactive flow data — see details`,
        issues,
      };
    }
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
    const stepData = side === "prod" ? prodStep : candStep;
    if (
      stepData &&
      stepData.mode !== "page-link" &&
      stepData.mode !== "none" &&
      stepData.mode !== "unknown"
    ) {
      // Interactive mode is load-more/infinite-scroll — a `?page=N` fetch
      // probe is meaningless here (the server ignoring the param is
      // expected behavior, not a bug) and was a known false-positive
      // source. Trust the interactive verdict instead.
      data[`${side}_page_counts`] = { skippedFetchProbe: true, reason: `mode=${stepData.mode}` };
      continue;
    }
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
    if (prodCounts && candCounts && "page2" in prodCounts && "page2" in candCounts) {
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
        ? "PLP pagination working on both sides (tested page=2 + page=3)"
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
    for (;;) {
      const m = re.exec(html);
      if (!m) break;
      const path = m[1];
      if (!path) continue;
      // Normalize: drop query, drop trailing slash. We're checking SET
      // membership, so we want each product counted once regardless of
      // skuId query params or trailing slash variation.
      const normalized = path.split("?")[0]!.replace(/\/$/, "");
      paths.add(normalized);
    }
    const re2 = /href="([^"]+\/products\/[^"]+)"/gi;
    for (;;) {
      const m = re2.exec(html);
      if (!m) break;
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
/** Exported for reuse by `plp-sorting.ts`. */
export async function discoverPlpFromHome(homeUrl: string): Promise<string | null> {
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
    for (;;) {
      const m = re.exec(html);
      if (!m) break;
      const href = m[1];
      if (!href) continue;
      // Skip non-PLP hrefs
      if (
        /^https?:\/\//.test(href) ||
        href.startsWith("#") ||
        href === "/" ||
        /\/(p|cart|carrinho|checkout|account|conta|login|wishlist|favoritos)(\/|$|\?)/i.test(
          href,
        ) ||
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

/** Exported for reuse by `plp-sorting.ts` — same "where's the PLP" heuristic. */
export function pickPlpUrl(flows: CheckContext["prodFlows"]): string | null {
  for (const fc of flows) {
    // The interactive `plp` flow captures the PLP page directly too (no
    // purchase-journey required) — so a `--flows plp`-only run can still
    // feed this check a URL instead of falling all the way back to
    // scraping the home page.
    if (fc.flow !== "purchase-journey" && fc.flow !== "plp") continue;
    if (fc.flow === "purchase-journey") {
      const plpStep = fc.steps?.find((s) => s.name === "navigate-plp" && s.status === "ok");
      if (plpStep?.url) return plpStep.url;
    }
    // Fallback: any PLP-looking URL in the captured pages
    const plpPage: PageCapture | undefined = fc.pages.find((p) => {
      try {
        const u = new URL(p.url);
        // PLP heuristic: depth-1 or depth-2 path, not /p or /products
        return (
          u.pathname.split("/").filter(Boolean).length <= 2 && !/\/p$|\/products\//.test(u.pathname)
        );
      } catch {
        return false;
      }
    });
    if (plpPage) return plpPage.url;
  }
  return null;
}

/** Overlap helper used by the fetch-based fallback — re-exported from the
 *  shared pure module so this file and `engine/flows/simple.ts` can't
 *  drift on the overlap formula. */
const setOverlap = hrefOverlap;

interface PlpStepPaginationData {
  /** Mode reported by `detect-pagination-mode` ("unknown" if that step is missing). */
  mode: string;
  /** Status of `verify-pagination` ("skipped" for mode=none, null if the step never ran). */
  verifyStatus: "ok" | "skipped" | "failed" | null;
  detail?: Record<string, unknown>;
}

/**
 * Pull the interactive pagination verdict out of a side's `plp` FlowCapture,
 * if one ran. Returns null when no `plp` flow (with these steps) is present
 * — the caller then falls back entirely to the fetch-based probe for that
 * side, exactly like before this feature existed.
 */
function pickPlpStepData(flows: FlowCapture[]): PlpStepPaginationData | null {
  for (const fc of flows) {
    if (fc.flow !== "plp") continue;
    const steps = fc.steps ?? [];
    const detectStep = steps.find((s) => s.name === "detect-pagination-mode");
    const verifyStep = steps.find((s) => s.name === "verify-pagination");
    if (!detectStep && !verifyStep) continue;
    const mode = (detectStep?.detail?.mode as string | undefined) ?? "unknown";
    return { mode, verifyStatus: verifyStep?.status ?? null, detail: verifyStep?.detail };
  }
  return null;
}
