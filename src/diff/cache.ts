import type { NetworkEntry } from "../types/schema.ts";

export type CacheDecision = "hit" | "miss" | "bypass" | "cacheable" | "unknown";

export type ResourceCategory =
  | "document"
  | "static-asset"
  | "image"
  | "font"
  | "api"
  | "third-party"
  | "other";

export interface ClassifiedRequest {
  entry: NetworkEntry;
  decision: CacheDecision;
  category: ResourceCategory;
  /** True when this is an opportunity to enable cache (e.g. hashed asset MISS) */
  opportunity: boolean;
}

/** Minimum max-age to consider an asset "properly cacheable" (60s, so we don't
 *  flag short-TTL responses as cached). VTEX edge defaults to 5min, Cloudflare
 *  defaults to 4h for static — anything ≥60s is a deliberate cache config. */
const CACHEABLE_MAX_AGE_MIN = 60;

function parseMaxAge(cc: string): number | null {
  const m = cc.match(/(?:^|[,\s;])s-maxage=(\d+)/i) ?? cc.match(/(?:^|[,\s;])max-age=(\d+)/i);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

/**
 * Determine cache HIT/MISS/BYPASS/CACHEABLE using common edge headers.
 *
 * "cacheable" is a NEW decision that means: the response is configured with a
 * proper `cache-control: public, max-age=Nlong` even though Playwright reports
 * `fromCache: false`. A fresh browser session always has an empty cache so
 * `fromCache=false` is meaningless on first visit — what matters is whether
 * the asset CAN be cached. Treating `cacheable` as "not an opportunity"
 * eliminates 200+ false positives per run on sites that DO ship correct
 * cache headers but were just visited cold.
 */
export function cacheDecision(entry: NetworkEntry): CacheDecision {
  if (entry.fromCache) return "hit";
  const cc = (entry.cacheControl ?? "").toLowerCase();
  if (cc.includes("no-store") || cc.includes("no-cache") || cc.includes("private")) {
    return "bypass";
  }
  if (cc.includes("public") || cc.includes("immutable")) {
    const maxAge = parseMaxAge(cc) ?? 0;
    if (maxAge >= CACHEABLE_MAX_AGE_MIN) return "cacheable";
  }
  // Even without `public`, a long max-age means the resource is meant to cache.
  const maxAge = parseMaxAge(cc);
  if (maxAge != null && maxAge >= CACHEABLE_MAX_AGE_MIN) return "cacheable";
  return "unknown";
}

const HASH_IN_FILENAME =
  /\.[a-f0-9]{8,32}\.(js|css|woff2?|png|jpe?g|webp|avif|svg|gif|mp4|webm)(\?|$)/i;
const HASH_AT_END = /-[a-f0-9]{8,32}\.(js|css|woff2?|png|jpe?g|webp|avif|svg|gif|mp4|webm)(\?|$)/i;

export function isStaticAssetWithHash(url: string): boolean {
  return HASH_IN_FILENAME.test(url) || HASH_AT_END.test(url);
}

const KNOWN_THIRD_PARTY_HOSTS = [
  "googletagmanager.com",
  "google-analytics.com",
  "google.com",
  "googleadservices.com",
  "doubleclick.net",
  "facebook.com",
  "facebook.net",
  "connect.facebook.net",
  "hotjar.com",
  "clarity.ms",
  "crazyegg.com",
  "recaptcha.net",
  "gstatic.com",
  "linkedin.com",
  "tiktok.com",
  "criteo.com",
  "pinterest.com",
  "snapchat.com",
];

export function isThirdParty(url: string, baseHost: string | null): boolean {
  try {
    const u = new URL(url);
    if (KNOWN_THIRD_PARTY_HOSTS.some((h) => u.hostname.endsWith(h))) return true;
    if (!baseHost) return false;
    // Hosts that aren't the base host AND aren't the asset CDN of the base host
    // (e.g. assets.bagaggio.com.br for bagaggio.com.br) → third-party
    if (u.hostname === baseHost) return false;
    if (u.hostname.endsWith(`.${baseHost}`)) return false;
    // strip "www." for comparison
    const cleanedBase = baseHost.replace(/^www\./, "");
    if (u.hostname === cleanedBase) return false;
    if (u.hostname.endsWith(`.${cleanedBase}`)) return false;
    // Known same-org patterns for commerce CDNs / image proxies.
    // - vtexassets.com, vteximg.com.br  → VTEX-hosted CDN
    // - decoassets.com                  → deco asset storage
    // - decocache.com                   → deco edge cache
    // - decoims.com                     → deco image optimizer / proxy
    // These are all under the storefront's own infra, not third-party trackers,
    // so they must remain eligible for `cache-coverage` opportunities instead
    // of being silently skipped as cross-org.
    if (
      u.hostname.includes("vtexassets") ||
      u.hostname.includes("decoassets") ||
      u.hostname.includes("vteximg") ||
      u.hostname.includes("decocache") ||
      u.hostname.includes("decoims")
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

export function classifyResource(entry: NetworkEntry, baseHost: string | null): ResourceCategory {
  if (isThirdParty(entry.url, baseHost)) return "third-party";

  const rt = entry.resourceType;
  const url = entry.url.toLowerCase();

  if (rt === "document") return "document";
  if (rt === "image") return "image";
  if (rt === "font" || /\.woff2?(\?|$)/i.test(url)) return "font";
  if (rt === "stylesheet" || /\.css(\?|$)/i.test(url)) return "static-asset";
  if (rt === "script") return "static-asset";
  if (
    rt === "xhr" ||
    rt === "fetch" ||
    /\/api\//.test(url) ||
    /\/_loader\//.test(url) ||
    /\/deco\/render/.test(url)
  )
    return "api";
  return "other";
}

export function classifyAll(entries: NetworkEntry[], baseUrl: string): ClassifiedRequest[] {
  let baseHost: string | null = null;
  try {
    baseHost = new URL(baseUrl).hostname;
  } catch {
    /* tolerate */
  }
  return entries.map((entry) => {
    const decision = cacheDecision(entry);
    const category = classifyResource(entry, baseHost);
    const opportunity = isOpportunity(entry, decision, category);
    return { entry, decision, category, opportunity };
  });
}

/**
 * An "opportunity" = a request that *should* cache but doesn't. The cand worker
 * could add a cache rule for it and reduce bytes/latency.
 */
function isOpportunity(
  entry: NetworkEntry,
  decision: CacheDecision,
  category: ResourceCategory,
): boolean {
  if (decision === "hit") return false;
  // Asset already has a proper public/long-max-age cache config — not an
  // opportunity, just a cold browser session. Don't bother the user with
  // this on the report.
  if (decision === "cacheable") return false;
  if (decision === "bypass") return false;
  if (category === "third-party") return false;
  if (category === "api") return false; // intentional dynamic
  if (category === "document") return false; // sometimes intentional
  if (category === "static-asset" || category === "image" || category === "font") {
    // hashed assets really should cache forever
    return true;
  }
  return false;
}

export interface CacheReport {
  total: number;
  totalBytes: number;
  byDecision: Record<CacheDecision, number>;
  byCategory: Record<ResourceCategory, { count: number; bytes: number; hitRate: number }>;
  hitRate: number;
  opportunities: ClassifiedRequest[];
  /** All classified requests (used by the renderer to build full tables) */
  all: ClassifiedRequest[];
}

const EMPTY_CATEGORY: ResourceCategory[] = [
  "document",
  "static-asset",
  "image",
  "font",
  "api",
  "third-party",
  "other",
];

export function buildCacheReport(entries: NetworkEntry[], baseUrl: string): CacheReport {
  const all = classifyAll(entries, baseUrl);
  const byDecision: Record<CacheDecision, number> = {
    hit: 0,
    miss: 0,
    bypass: 0,
    cacheable: 0,
    unknown: 0,
  };
  const byCategoryAcc: Record<ResourceCategory, { count: number; bytes: number; hits: number }> = {
    document: { count: 0, bytes: 0, hits: 0 },
    "static-asset": { count: 0, bytes: 0, hits: 0 },
    image: { count: 0, bytes: 0, hits: 0 },
    font: { count: 0, bytes: 0, hits: 0 },
    api: { count: 0, bytes: 0, hits: 0 },
    "third-party": { count: 0, bytes: 0, hits: 0 },
    other: { count: 0, bytes: 0, hits: 0 },
  };
  let totalBytes = 0;
  for (const r of all) {
    byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
    const bytes = r.entry.bytes ?? 0;
    totalBytes += bytes;
    const cat = byCategoryAcc[r.category];
    cat.count++;
    cat.bytes += bytes;
    if (r.decision === "hit") cat.hits++;
  }
  const byCategory: CacheReport["byCategory"] = {} as CacheReport["byCategory"];
  for (const cat of EMPTY_CATEGORY) {
    const acc = byCategoryAcc[cat];
    byCategory[cat] = {
      count: acc.count,
      bytes: acc.bytes,
      hitRate: acc.count > 0 ? acc.hits / acc.count : 0,
    };
  }
  const consideredForRate = all.filter((r) => r.category !== "third-party");
  // "cacheable" assets (proper public/max-age headers) count as effectively
  // cached for the hit-rate — they'd hit on the second visit. Without this,
  // a cold-browser run reports near-0% hit rate even on well-configured sites.
  const hits = consideredForRate.filter(
    (r) => r.decision === "hit" || r.decision === "cacheable",
  ).length;
  const hitRate = consideredForRate.length > 0 ? hits / consideredForRate.length : 0;
  const opportunities = all
    .filter((r) => r.opportunity)
    .sort((a, b) => (b.entry.bytes ?? 0) - (a.entry.bytes ?? 0));
  return {
    total: all.length,
    totalBytes,
    byDecision,
    byCategory,
    hitRate,
    opportunities,
    all,
  };
}
