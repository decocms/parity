import * as cheerio from "cheerio";

export type Platform =
  | "vtex"
  | "vtex-fs"
  | "shopify"
  | "salesforce-commerce"
  | "deco"
  | "wake"
  | "nuvemshop"
  | "custom";

/**
 * Site profile — the axis that decides whether commerce-only checks/flows make
 * sense. A content/blog site has no PLP/PDP/cart/CEP, so running the purchase
 * journey there is either a meaningless 100 or a spurious failure (issues
 * #254/#255). Distinct from `Platform`: `Platform` says "how it's built",
 * `SiteProfile` says "what it is".
 */
export type SiteProfile = "commerce" | "content";

const COMMERCE_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>([
  "vtex",
  "vtex-fs",
  "shopify",
  "salesforce-commerce",
  "wake",
  "nuvemshop",
]);

/**
 * Map a detected platform to a default site profile. Known storefront
 * platforms are commerce; a bare framework (`deco`) or an unrecognized stack
 * (`custom`) defaults to content — the safe assumption for a site that showed
 * no commerce signal. The user can always override with `--profile`.
 */
export function profileForPlatform(platform: Platform): SiteProfile {
  return COMMERCE_PLATFORMS.has(platform) ? "commerce" : "content";
}

export interface PlatformDetectionInput {
  url: string;
  html?: string;
  headers?: Record<string, string>;
}

/**
 * Detect e-commerce platform from URL, HTTP headers, and HTML markup.
 * Heuristic in order of confidence; falls back to "custom" when no signal matches.
 */
export function detectPlatform(input: PlatformDetectionInput): Platform {
  // 1. URL patterns (high confidence)
  const urlPlatform = detectFromUrl(input.url);
  if (urlPlatform !== "custom") return urlPlatform;

  // 2. HTTP headers
  if (input.headers) {
    const fromHeaders = detectFromHeaders(input.headers);
    if (fromHeaders !== "custom") return fromHeaders;
  }

  // 3. HTML markup
  if (input.html) {
    const fromHtml = detectFromHtml(input.html);
    if (fromHtml !== "custom") return fromHtml;
  }

  return "custom";
}

function detectFromUrl(url: string): Platform {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host.endsWith(".myvtex.com") || host.endsWith(".vtex.app")) return "vtex";
    if (host.endsWith(".myshopify.com")) return "shopify";
    if (host.endsWith(".lojavirtualnuvem.com.br") || host.endsWith(".nuvemshop.com.br"))
      return "nuvemshop";
    if (host.endsWith(".fbits.store") || host.endsWith(".wake.tech")) return "wake";
    if (host.endsWith(".deco.site") || host.endsWith(".deco-cx.workers.dev")) return "deco";
  } catch {
    /* invalid URL */
  }
  return "custom";
}

function detectFromHeaders(headers: Record<string, string>): Platform {
  const norm = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]),
  );

  if (norm["x-vtex-account"] || norm["x-vtex-workspace"]) return "vtex";
  if ((norm["x-powered-by"] ?? "").includes("shopify")) return "shopify";

  const server = norm.server ?? "";
  if (server.includes("vtex")) return "vtex";
  if (server.includes("shopify")) return "shopify";

  return "custom";
}

function detectFromHtml(html: string): Platform {
  try {
    // Salesforce Commerce Cloud (Demandware) — checked FIRST because its
    // static-asset host (`demandware.static`) and `/on/demandware.store/`
    // paths are unambiguous, whereas the generic `fs-`/`vtex-` substring
    // checks below can false-positive on a Demandware store that happens to
    // use `fs-`/utility classes (issue #199: Sephora BR mis-detected as vtex).
    if (html.includes("demandware.static") || html.includes("/on/demandware.store/")) {
      return "salesforce-commerce";
    }

    const $ = cheerio.load(html);

    // VTEX FastStore (newer)
    const fsClasses = $('[class*="fs-"], [data-fs-]').length;
    if (fsClasses > 5) return "vtex-fs";

    // VTEX legacy / IO
    const vtexClasses = $('[class*="vtex-"]').length;
    if (vtexClasses > 5) return "vtex";

    // Shopify
    const shopifyClasses = $('[class*="shopify-"]').length;
    if (shopifyClasses > 3) return "shopify";
    if ($("meta[name='shopify-checkout-api-token']").length > 0) return "shopify";

    // Deco
    const decoMarkers = $("[data-deco], [data-section], [data-deco-product]").length;
    if (decoMarkers > 3) return "deco";

    // Wake / fbits
    if ($("script[src*='fbits']").length > 0) return "wake";

    // Nuvemshop
    if ($("script[src*='nuvemshop']").length > 0) return "nuvemshop";

    // Generator meta
    const generator = $("meta[name='generator']").attr("content")?.toLowerCase() ?? "";
    if (generator.includes("vtex")) return "vtex";
    if (generator.includes("shopify")) return "shopify";
    if (generator.includes("demandware") || generator.includes("salesforce"))
      return "salesforce-commerce";
    if (generator.includes("deco")) return "deco";
  } catch {
    /* ignore */
  }
  return "custom";
}
