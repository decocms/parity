import { snapshotDom } from "../diff/dom.ts";
import {
  diffBreadcrumbSchema,
  diffOrganizationSchema,
  diffProductSchema,
  extractJsonLd,
} from "../diff/jsonld.ts";
import { diffRobots, fetchRobots, parseRobots } from "../diff/robots.ts";
import { diffSitemap, resolveSitemapUrls } from "../diff/sitemap.ts";
import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

interface SeoState {
  prodBaseUrl: string;
  candBaseUrl: string;
}

export async function seoDeepAudit(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  if (pairs.length === 0) {
    return emptyResult(start);
  }

  const sample = pairs[0]!;
  const state: SeoState = {
    prodBaseUrl: originOf(sample.prod.url),
    candBaseUrl: originOf(sample.cand.url),
  };

  // Per-page sub-checks
  for (const pair of pairs) {
    issues.push(...checkMetaRobots(pair));
    issues.push(...checkXRobotsHeader(pair));
    issues.push(...checkCanonical(pair));
    issues.push(...checkHreflang(pair));
    issues.push(...checkJsonLd(pair));
  }

  // Run-wide sub-checks (only once per run)
  issues.push(...(await checkRobotsTxt(state)));
  issues.push(...(await checkSitemap(state, pairs.map((p) => p.cand))));

  return {
    name: "seo-deep-audit",
    status: issues.some((i) => i.severity === "critical")
      ? "fail"
      : issues.length > 0
        ? "warn"
        : "pass",
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} divergência(s) de SEO em ${pairs.length} página(s)`,
    issues,
    data: { pages: pairs.length },
  };
}

function checkMetaRobots(pair: { prod: PageCapture; cand: PageCapture; key: string }): Issue[] {
  const prodMeta = snapshotDom(pair.prod.html).meta.robots ?? "";
  const candMeta = snapshotDom(pair.cand.html).meta.robots ?? "";
  const prodIndexable = !/\bnoindex\b/i.test(prodMeta);
  const candIndexable = !/\bnoindex\b/i.test(candMeta);
  const prodFollowable = !/\bnofollow\b/i.test(prodMeta);
  const candFollowable = !/\bnofollow\b/i.test(candMeta);

  const out: Issue[] = [];
  if (prodIndexable && !candIndexable) {
    out.push({
      id: `seo:noindex-introduced:${pair.key}`,
      severity: "critical",
      category: "seo",
      page: pair.key,
      check: "seo-deep-audit",
      summary: `cand introduziu 'noindex' em ${pair.key} (prod era indexável) — página sairá do Google`,
      details: `prod meta robots: "${prodMeta || "—"}"\ncand meta robots: "${candMeta || "—"}"`,
    });
  }
  if (prodFollowable && !candFollowable) {
    out.push({
      id: `seo:nofollow-introduced:${pair.key}`,
      severity: "high",
      category: "seo",
      page: pair.key,
      check: "seo-deep-audit",
      summary: `cand introduziu 'nofollow' em ${pair.key} (prod era follow)`,
      details: `prod meta robots: "${prodMeta || "—"}"\ncand meta robots: "${candMeta || "—"}"`,
    });
  }
  return out;
}

function checkXRobotsHeader(pair: { prod: PageCapture; cand: PageCapture; key: string }): Issue[] {
  const p = (pair.prod.xRobotsTag ?? "").toLowerCase();
  const c = (pair.cand.xRobotsTag ?? "").toLowerCase();
  const prodIndexable = !/noindex/.test(p);
  const candIndexable = !/noindex/.test(c);
  if (prodIndexable && !candIndexable) {
    return [
      {
        id: `seo:x-robots-noindex:${pair.key}`,
        severity: "critical",
        category: "seo",
        page: pair.key,
        check: "seo-deep-audit",
        summary: `Header X-Robots-Tag em cand contém 'noindex' (prod=indexável) em ${pair.key}`,
        details: `prod X-Robots-Tag: "${pair.prod.xRobotsTag ?? "—"}"\ncand X-Robots-Tag: "${pair.cand.xRobotsTag ?? "—"}"`,
      },
    ];
  }
  if (p !== c && (p || c)) {
    return [
      {
        id: `seo:x-robots-diff:${pair.key}`,
        severity: "high",
        category: "seo",
        page: pair.key,
        check: "seo-deep-audit",
        summary: `Header X-Robots-Tag diverge em ${pair.key}`,
        details: `prod: "${pair.prod.xRobotsTag ?? "—"}"\ncand: "${pair.cand.xRobotsTag ?? "—"}"`,
      },
    ];
  }
  return [];
}

function checkCanonical(pair: { prod: PageCapture; cand: PageCapture; key: string }): Issue[] {
  const prodSnap = snapshotDom(pair.prod.html);
  const candSnap = snapshotDom(pair.cand.html);
  const prodCanon = prodSnap.meta.canonical;
  const candCanon = candSnap.meta.canonical;
  const out: Issue[] = [];

  if (prodCanon && !candCanon) {
    out.push({
      id: `seo:canonical-missing:${pair.key}`,
      severity: "high",
      category: "seo",
      page: pair.key,
      check: "seo-deep-audit",
      summary: `Canonical sumiu em cand (${pair.key}) — prod tinha "${prodCanon}"`,
    });
    return out;
  }
  if (candCanon) {
    if (!isAbsoluteUrl(candCanon)) {
      out.push({
        id: `seo:canonical-relative:${pair.key}`,
        severity: "high",
        category: "seo",
        page: pair.key,
        check: "seo-deep-audit",
        summary: `Canonical em cand não é URL absoluta: "${candCanon}"`,
      });
    }
    // canonical points-self
    try {
      const candUrlPath = new URL(pair.cand.url).pathname;
      const canonPath = new URL(candCanon, pair.cand.url).pathname;
      if (canonPath !== candUrlPath && canonPath === "/" && candUrlPath !== "/") {
        out.push({
          id: `seo:canonical-home:${pair.key}`,
          severity: "medium",
          category: "seo",
          page: pair.key,
          check: "seo-deep-audit",
          summary: `Canonical aponta para home (/) em uma página interna (${pair.key}): "${candCanon}"`,
        });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

function checkHreflang(pair: { prod: PageCapture; cand: PageCapture; key: string }): Issue[] {
  const re = /<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["']/gi;
  const prodLangs = [...pair.prod.html.matchAll(re)].map((m) => m[1]).filter(Boolean).sort();
  const candLangs = [...pair.cand.html.matchAll(re)].map((m) => m[1]).filter(Boolean).sort();
  const prodSet = new Set(prodLangs);
  const candSet = new Set(candLangs);
  const onlyProd = [...prodSet].filter((l) => !candSet.has(l));
  if (onlyProd.length > 0) {
    return [
      {
        id: `seo:hreflang-missing:${pair.key}`,
        severity: "medium",
        category: "seo",
        page: pair.key,
        check: "seo-deep-audit",
        summary: `hreflang(s) ausentes em cand (${pair.key}): ${onlyProd.join(", ")}`,
      },
    ];
  }
  return [];
}

function checkJsonLd(pair: { prod: PageCapture; cand: PageCapture; key: string }): Issue[] {
  const out: Issue[] = [];
  const prodLd = extractJsonLd(pair.prod.html);
  const candLd = extractJsonLd(pair.cand.html);

  const productDiff = diffProductSchema(prodLd, candLd);
  if (productDiff.prodOnly) {
    out.push({
      id: `seo:jsonld-product-missing:${pair.key}`,
      severity: "high",
      category: "seo",
      page: pair.key,
      check: "seo-deep-audit",
      summary: `Product JSON-LD sumiu em cand (${pair.key}) — rich snippet de produto será perdido`,
    });
  } else if (productDiff.bothPresent) {
    if (productDiff.missingFieldsInCand.length > 0) {
      out.push({
        id: `seo:jsonld-product-fields:${pair.key}`,
        severity: "high",
        category: "seo",
        page: pair.key,
        check: "seo-deep-audit",
        summary: `Campos críticos do Product JSON-LD ausentes em cand (${pair.key}): ${productDiff.missingFieldsInCand.join(", ")}`,
      });
    }
    if (productDiff.changedFields.length > 0) {
      out.push({
        id: `seo:jsonld-product-changed:${pair.key}`,
        severity: "medium",
        category: "seo",
        page: pair.key,
        check: "seo-deep-audit",
        summary: `Campos do Product JSON-LD mudaram em ${pair.key}: ${productDiff.changedFields.map((c) => c.field).join(", ")}`,
        details: productDiff.changedFields
          .map((c) => `• ${c.field}\n  prod: ${JSON.stringify(c.prod)}\n  cand: ${JSON.stringify(c.cand)}`)
          .join("\n"),
      });
    }
  }

  const breadcrumbDiff = diffBreadcrumbSchema(prodLd, candLd);
  if (breadcrumbDiff.prodOnly) {
    out.push({
      id: `seo:jsonld-breadcrumb-missing:${pair.key}`,
      severity: "medium",
      category: "seo",
      page: pair.key,
      check: "seo-deep-audit",
      summary: `BreadcrumbList JSON-LD sumiu em cand (${pair.key})`,
    });
  } else if (
    breadcrumbDiff.bothPresent &&
    breadcrumbDiff.prodItemCount !== breadcrumbDiff.candItemCount
  ) {
    out.push({
      id: `seo:jsonld-breadcrumb-count:${pair.key}`,
      severity: "medium",
      category: "seo",
      page: pair.key,
      check: "seo-deep-audit",
      summary: `Breadcrumb itens divergem em ${pair.key}: prod=${breadcrumbDiff.prodItemCount}, cand=${breadcrumbDiff.candItemCount}`,
    });
  }

  const orgDiff = diffOrganizationSchema(prodLd, candLd);
  if (orgDiff.prodPresent && !orgDiff.candPresent) {
    out.push({
      id: `seo:jsonld-organization-missing:${pair.key}`,
      severity: "low",
      category: "seo",
      page: pair.key,
      check: "seo-deep-audit",
      summary: `Organization JSON-LD sumiu em cand (${pair.key})`,
    });
  }

  return out;
}

async function checkRobotsTxt(state: SeoState): Promise<Issue[]> {
  const [prodTxt, candTxt] = await Promise.all([fetchRobots(state.prodBaseUrl), fetchRobots(state.candBaseUrl)]);
  const out: Issue[] = [];

  if (prodTxt && !candTxt) {
    out.push({
      id: "seo:robots-txt-missing",
      severity: "high",
      category: "seo",
      check: "seo-deep-audit",
      summary: "/robots.txt presente em prod mas ausente em cand",
    });
    return out;
  }
  if (!prodTxt && candTxt) {
    out.push({
      id: "seo:robots-txt-new",
      severity: "low",
      category: "seo",
      check: "seo-deep-audit",
      summary: "/robots.txt presente em cand mas ausente em prod (verifique se intencional)",
    });
  }
  if (!prodTxt || !candTxt) return out;

  const diff = diffRobots(parseRobots(prodTxt), parseRobots(candTxt));
  for (const ua of diff.uaDiffs) {
    const detailParts: string[] = [];
    if (ua.disallowOnlyCand.length > 0) {
      detailParts.push(`Novos Disallow em cand: ${ua.disallowOnlyCand.join(", ")}`);
    }
    if (ua.disallowOnlyProd.length > 0) {
      detailParts.push(`Disallow removidos em cand: ${ua.disallowOnlyProd.join(", ")}`);
    }
    if (ua.allowOnlyCand.length > 0) {
      detailParts.push(`Novos Allow em cand: ${ua.allowOnlyCand.join(", ")}`);
    }
    if (ua.allowOnlyProd.length > 0) {
      detailParts.push(`Allow removidos em cand: ${ua.allowOnlyProd.join(", ")}`);
    }
    if (ua.crawlDelayProd !== ua.crawlDelayCand) {
      detailParts.push(`Crawl-delay: prod=${ua.crawlDelayProd ?? "—"}, cand=${ua.crawlDelayCand ?? "—"}`);
    }
    out.push({
      id: `seo:robots-txt-ua:${ua.userAgent}`,
      severity: ua.disallowOnlyCand.length > 0 ? "high" : "medium",
      category: "seo",
      check: "seo-deep-audit",
      summary: `robots.txt divergente para User-agent "${ua.userAgent}"`,
      details: detailParts.join("\n"),
    });
  }
  if (diff.sitemapDiff.onlyProd.length > 0) {
    out.push({
      id: "seo:robots-sitemap-missing",
      severity: "high",
      category: "seo",
      check: "seo-deep-audit",
      summary: `robots.txt em prod declara sitemap(s) ausente(s) em cand: ${diff.sitemapDiff.onlyProd.join(", ")}`,
    });
  }
  return out;
}

async function checkSitemap(state: SeoState, candPages: PageCapture[]): Promise<Issue[]> {
  const out: Issue[] = [];
  const [prodUrls, candUrls] = await Promise.all([
    resolveSitemapUrls(state.prodBaseUrl),
    resolveSitemapUrls(state.candBaseUrl),
  ]);

  if (prodUrls.length > 0 && candUrls.length === 0) {
    out.push({
      id: "seo:sitemap-missing",
      severity: "high",
      category: "seo",
      check: "seo-deep-audit",
      summary: `sitemap.xml presente em prod (${prodUrls.length} URLs) mas ausente em cand`,
    });
    return out;
  }
  if (prodUrls.length === 0) return out;

  const diff = diffSitemap(prodUrls, candUrls);
  if (diff.countPct < -0.05) {
    out.push({
      id: "seo:sitemap-url-count",
      severity: "medium",
      category: "seo",
      check: "seo-deep-audit",
      summary: `sitemap cand tem ${(Math.abs(diff.countPct) * 100).toFixed(0)}% menos URLs que prod (${diff.candCount} vs ${diff.prodCount})`,
      details: `Exemplos faltando em cand (primeiros 20):\n${diff.onlyProdSample.join("\n")}`,
    });
  }

  // priority pages: pages we actually visited in cand must be in sitemap
  const candHostedPaths = new Set(
    candPages
      .map((p) => {
        try {
          return new URL(p.url).pathname;
        } catch {
          return null;
        }
      })
      .filter((p): p is string => !!p),
  );
  const sitemapPaths = new Set(
    candUrls
      .map((u) => {
        try {
          return new URL(u).pathname;
        } catch {
          return null;
        }
      })
      .filter((p): p is string => !!p),
  );
  const missingPriority = [...candHostedPaths].filter((p) => !sitemapPaths.has(p));
  if (missingPriority.length > 0) {
    out.push({
      id: "seo:sitemap-priority-pages",
      severity: "high",
      category: "seo",
      check: "seo-deep-audit",
      summary: `${missingPriority.length} página(s) crítica(s) navegada(s) na jornada não estão no sitemap cand`,
      details: missingPriority.join("\n"),
    });
  }
  return out;
}

function emptyResult(start: number): CheckResult {
  return {
    name: "seo-deep-audit",
    status: "skipped",
    severity: "high",
    durationMs: Date.now() - start,
    summary: "Nenhum par de páginas para auditar",
    issues: [],
  };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function isAbsoluteUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
