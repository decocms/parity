import * as cheerio from "cheerio";

export interface ParsedSitemap {
  urls: string[];
  lastmod: Record<string, string>;
  isIndex: boolean;
  childSitemaps: string[];
}

const MAX_URLS = 1000;

export async function fetchSitemap(
  baseUrl: string,
  hintUrl?: string,
  timeoutMs = 15_000,
): Promise<{ url: string; xml: string } | null> {
  const candidates = hintUrl
    ? [hintUrl]
    : [new URL("/sitemap.xml", baseUrl).toString(), new URL("/sitemap_index.xml", baseUrl).toString()];

  for (const url of candidates) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; parity-cli/0.1; +https://github.com/decocms/parity)",
        },
        redirect: "follow",
      });
      if (!res.ok) continue;
      const xml = await res.text();
      if (xml.trim().startsWith("<")) {
        return { url, xml };
      }
    } catch {
      /* try next */
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}

export function parseSitemap(xml: string): ParsedSitemap {
  const out: ParsedSitemap = { urls: [], lastmod: {}, isIndex: false, childSitemaps: [] };
  try {
    const $ = cheerio.load(xml, { xml: true });

    // sitemap-index?
    const sitemapNodes = $("sitemap > loc");
    if (sitemapNodes.length > 0) {
      out.isIndex = true;
      sitemapNodes.each((_, el) => {
        const loc = $(el).text().trim();
        if (loc) out.childSitemaps.push(loc);
      });
      return out;
    }

    // urlset
    $("url").each((_, urlEl) => {
      if (out.urls.length >= MAX_URLS) return;
      const $url = $(urlEl);
      const loc = $url.find("loc").first().text().trim();
      if (!loc) return;
      out.urls.push(loc);
      const lastmod = $url.find("lastmod").first().text().trim();
      if (lastmod) out.lastmod[loc] = lastmod;
    });
  } catch {
    /* ignore parse errors */
  }
  return out;
}

/**
 * Resolves a sitemap into a flat list of URLs, recursing one level of sitemap-index.
 */
export async function resolveSitemapUrls(baseUrl: string, hintUrl?: string): Promise<string[]> {
  const root = await fetchSitemap(baseUrl, hintUrl);
  if (!root) return [];
  const parsed = parseSitemap(root.xml);
  if (!parsed.isIndex) return parsed.urls;

  const all: string[] = [];
  for (const child of parsed.childSitemaps.slice(0, 20)) {
    if (all.length >= MAX_URLS) break;
    const childRes = await fetchSitemap(baseUrl, child);
    if (!childRes) continue;
    const childParsed = parseSitemap(childRes.xml);
    for (const u of childParsed.urls) {
      if (all.length >= MAX_URLS) break;
      all.push(u);
    }
  }
  return all;
}

export interface SitemapDiff {
  prodPresent: boolean;
  candPresent: boolean;
  prodCount: number;
  candCount: number;
  countDelta: number;
  countPct: number;
  onlyProdSample: string[];
  onlyCandSample: string[];
}

export function diffSitemap(prodUrls: string[], candUrls: string[]): SitemapDiff {
  const prodSet = new Set(prodUrls);
  const candSet = new Set(candUrls);
  const onlyProd = [...prodSet].filter((u) => !candSet.has(u));
  const onlyCand = [...candSet].filter((u) => !prodSet.has(u));
  const countDelta = candUrls.length - prodUrls.length;
  const countPct = prodUrls.length > 0 ? countDelta / prodUrls.length : 0;
  return {
    prodPresent: prodUrls.length > 0,
    candPresent: candUrls.length > 0,
    prodCount: prodUrls.length,
    candCount: candUrls.length,
    countDelta,
    countPct,
    onlyProdSample: onlyProd.slice(0, 20),
    onlyCandSample: onlyCand.slice(0, 20),
  };
}
