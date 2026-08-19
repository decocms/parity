import * as cheerio from "cheerio";
import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

interface LinkProbeResult {
  url: string;
  status: number;
  durationMs: number;
}

const FOOTER_LATENCY_REGRESSION_RATIO = 1.5;

/**
 * Extract footer <a href> links from the home page and HEAD each one.
 * Critical when cand has a link that 4xx/5xx where prod's same path was 2xx
 * — broken institutional pages (contact, privacy, etc.) are a common
 * regression after route migrations.
 */
export async function footerLinksHealth(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  const maxLinks = ctx.rc.footer?.maxLinks ?? 20;
  const followExternal = ctx.rc.footer?.followExternal ?? false;

  const prodHome = pickHome(ctx.prodPages);
  const candHome = pickHome(ctx.candPages);
  if (!prodHome && !candHome) {
    return {
      name: "footer-links-health",
      status: "skipped",
      severity: "medium",
      durationMs: Date.now() - start,
      summary: "Nenhuma captura de home — não há footer para extrair links",
      issues: [],
    };
  }

  const single = !prodHome || !candHome;

  if (single) {
    const home = prodHome ?? candHome!;
    const links = extractFooterLinks(home, { followExternal, maxLinks });
    const results = await probeLinks(links);
    for (const r of results) {
      if (r.status >= 400 || r.status === 0) {
        issues.push({
          id: `footer-links:single:${r.url}`,
          severity: "high",
          category: "functional",
          check: "footer-links-health",
          summary: `Link de footer retornou HTTP ${r.status}: ${r.url}`,
          page: home.url,
        });
      }
    }
  } else {
    const prodLinks = extractFooterLinks(prodHome!, { followExternal, maxLinks });
    const candLinks = extractFooterLinks(candHome!, { followExternal, maxLinks });
    const prodResults = await probeLinks(prodLinks);
    const candResults = await probeLinks(candLinks);
    const prodByPath = new Map(prodResults.map((r) => [pathOf(r.url), r] as const));
    const candByPath = new Map(candResults.map((r) => [pathOf(r.url), r] as const));

    for (const [path, candR] of candByPath) {
      const prodR = prodByPath.get(path);
      const candBroken = candR.status >= 400 || candR.status === 0;
      const prodOk = prodR && prodR.status >= 200 && prodR.status < 400;
      if (candBroken && prodOk) {
        issues.push({
          id: `footer-links:broken-cand:${path}`,
          severity: "critical",
          category: "functional",
          check: "footer-links-health",
          summary: `Link de footer "${path}" retornou HTTP ${candR.status} em cand (prod retornou ${prodR.status})`,
        });
      } else if (candBroken && !prodR) {
        issues.push({
          id: `footer-links:broken-cand-only:${path}`,
          severity: "medium",
          category: "functional",
          check: "footer-links-health",
          summary: `Link de footer "${path}" só existe em cand e retornou HTTP ${candR.status}`,
        });
      }
    }

    // Latency regression
    const prodAvg = average(prodResults.map((r) => r.durationMs).filter((d) => d > 0));
    const candAvg = average(candResults.map((r) => r.durationMs).filter((d) => d > 0));
    if (prodAvg > 0 && candAvg / prodAvg > FOOTER_LATENCY_REGRESSION_RATIO) {
      issues.push({
        id: "footer-links:latency-regression",
        severity: "medium",
        category: "performance",
        check: "footer-links-health",
        summary: `Latência média de links de footer piorou ${((candAvg / prodAvg - 1) * 100).toFixed(0)}%: ${prodAvg.toFixed(0)}ms → ${candAvg.toFixed(0)}ms`,
      });
    }
  }

  const status: CheckResult["status"] = issues.some((i) => i.severity === "critical")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";

  return {
    name: "footer-links-health",
    status,
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) — mode: ${single ? "single-site" : "comparative"}`,
    issues,
  };
}

function pickHome(pages: PageCapture[]): PageCapture | undefined {
  return pages.find((p) => {
    try {
      const path = new URL(p.url).pathname;
      return path === "/" || path === "";
    } catch {
      return false;
    }
  });
}

function extractFooterLinks(
  page: PageCapture,
  opts: { followExternal: boolean; maxLinks: number },
): string[] {
  const out: string[] = [];
  try {
    const $ = cheerio.load(page.html);
    const baseHost = (() => {
      try {
        return new URL(page.url).host;
      } catch {
        return "";
      }
    })();
    $("footer a[href]").each((_, el) => {
      const href = $(el).attr("href")?.trim();
      if (!href) return;
      if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
      let absolute: string;
      try {
        absolute = new URL(href, page.url).toString();
      } catch {
        return;
      }
      try {
        const linkHost = new URL(absolute).host;
        if (!opts.followExternal && linkHost !== baseHost) return;
      } catch {
        return;
      }
      if (!out.includes(absolute)) out.push(absolute);
    });
  } catch {
    /* ignore */
  }
  return out.slice(0, opts.maxLinks);
}

async function probeLinks(urls: string[]): Promise<LinkProbeResult[]> {
  return Promise.all(
    urls.map(async (url) => {
      const t = Date.now();
      try {
        const res = await fetch(url, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(8_000),
        });
        return { url, status: res.status, durationMs: Date.now() - t };
      } catch {
        return { url, status: 0, durationMs: Date.now() - t };
      }
    }),
  );
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
