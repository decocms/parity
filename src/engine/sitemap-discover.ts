import { resolveSitemapUrls } from "../diff/sitemap.ts";

export type PageKind = "home" | "plp" | "pdp" | "other";

export interface ClassifiedPage {
  path: string;
  kind: PageKind;
}

export interface VisualPagesSample {
  home: string;
  plps: string[];
  pdps: string[];
  all: ClassifiedPage[];
}

/**
 * Classify a URL path as home / plp / pdp / other using cheap heuristics.
 * Tuned for VTEX (/p suffix, /categoria-slug), Shopify (/products/, /collections/),
 * and generic Deco patterns.
 */
export function classifyPath(pathname: string): PageKind {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/" || p === "") return "home";

  // PDP heuristics — common product URL shapes
  // VTEX: /algum-produto/p  or /algum-produto-12345/p
  if (/\/p(?:\/|$)/.test(p)) return "pdp";
  // VTEX: ends with -<digits> (SKU id baked into slug)
  if (/-\d{4,}$/.test(p)) return "pdp";
  // Shopify / Woo style
  if (/^\/products?\//.test(p)) return "pdp";
  // Generic /produto/ or /product/
  if (/^\/produtos?\//.test(p) || /^\/products?\//.test(p)) return "pdp";

  // PLP heuristics — listing pages
  // Shopify / Woo: /collections/, /categoria/, /category/
  if (/^\/collections?\//.test(p)) return "plp";
  if (/^\/categorias?\//.test(p) || /^\/category\//.test(p)) return "plp";
  if (/^\/search\//.test(p) || /^\/busca\//.test(p)) return "plp";
  // VTEX departments / categories — single segment of slugs
  // (e.g. /vestidos, /moda-feminina) — defer to "other" unless segment heuristic matches
  const segments = p.split("/").filter(Boolean);
  if (segments.length === 1 && /^[a-z][a-z0-9-]+$/.test(segments[0]!)) {
    // Likely a department/category page in VTEX-style sites
    return "plp";
  }

  return "other";
}

export interface DiscoverOptions {
  /** Total pages to sample, default 5 (1 home + 2 plps + 2 pdps). */
  sampleSize?: number;
  /** Per-kind cap. If unset, derives from sampleSize. */
  caps?: { home?: number; plp?: number; pdp?: number };
  /** Hint URL for sitemap.xml location. */
  sitemapHint?: string;
}

/**
 * Discover a representative sample of pages from the prod sitemap.
 * Always includes home. Then picks up to `caps.plp` PLPs and `caps.pdp` PDPs.
 * If fewer than expected are found, fills remaining slots with "other" pages.
 */
export async function discoverPagesFromSitemap(
  prodUrl: string,
  opts: DiscoverOptions = {},
): Promise<VisualPagesSample> {
  const total = opts.sampleSize ?? 5;
  const caps = {
    home: opts.caps?.home ?? 1,
    plp: opts.caps?.plp ?? Math.max(1, Math.floor((total - 1) / 2)),
    pdp: opts.caps?.pdp ?? Math.max(1, total - 1 - Math.max(1, Math.floor((total - 1) / 2))),
  };

  const urls = await resolveSitemapUrls(prodUrl, opts.sitemapHint);

  const plps: string[] = [];
  const pdps: string[] = [];
  const others: string[] = [];
  const seen = new Set<string>(["/"]);

  for (const u of urls) {
    let path = "/";
    try {
      path = new URL(u).pathname || "/";
    } catch {
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);

    const kind = classifyPath(path);
    if (kind === "plp" && plps.length < caps.plp * 3) plps.push(path);
    else if (kind === "pdp" && pdps.length < caps.pdp * 3) pdps.push(path);
    else if (kind === "other" && others.length < 10) others.push(path);
  }

  // Take first N of each (sitemap order is usually most-popular-first)
  const selPlps = plps.slice(0, caps.plp);
  const selPdps = pdps.slice(0, caps.pdp);

  const result: VisualPagesSample = {
    home: "/",
    plps: selPlps,
    pdps: selPdps,
    all: [
      { path: "/", kind: "home" },
      ...selPlps.map((p) => ({ path: p, kind: "plp" as const })),
      ...selPdps.map((p) => ({ path: p, kind: "pdp" as const })),
    ],
  };

  // Fill remaining slots with "other" pages if we couldn't find enough plp/pdp
  const filled = 1 + selPlps.length + selPdps.length;
  if (filled < total) {
    const slots = total - filled;
    for (const p of others.slice(0, slots)) {
      result.all.push({ path: p, kind: "other" });
    }
  }

  return result;
}

/**
 * Build a human-friendly label for a discovered page.
 * E.g. "/" -> "Home", "/vestidos" -> "PLP · /vestidos"
 */
export function labelForDiscoveredPage(path: string, kind: PageKind): string {
  if (kind === "home") return "Home";
  const niceKind =
    kind === "plp" ? "PLP" : kind === "pdp" ? "PDP" : "Page";
  return `${niceKind} · ${path}`;
}
