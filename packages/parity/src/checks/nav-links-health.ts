import * as cheerio from "cheerio";
import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

interface NavLink {
  href: string;
  text: string;
}

/**
 * Nav/header link health. Complements footer-links-health for the top nav, and
 * adds same-page anchor validation: a menu item `href="#depoimentos"` with no
 * `id="depoimentos"` anywhere on the page silently does nothing when clicked.
 * A link that works on prod but 4xx/dead on cand is a migration regression; one
 * dead on both is pre-existing (still worth flagging, low).
 */
export async function navLinksHealth(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  const prodHome = pickHome(ctx.prodPages);
  const candHome = pickHome(ctx.candPages);
  if (!candHome && !prodHome) {
    return {
      name: "nav-links-health",
      status: "skipped",
      severity: "high",
      durationMs: Date.now() - start,
      summary: "Nenhuma captura de home — sem nav para validar",
      issues: [],
    };
  }

  // Dead same-page anchors on the candidate.
  if (candHome) {
    for (const dead of deadAnchors(candHome)) {
      const prodDead = prodHome ? deadAnchors(prodHome).includes(dead) : false;
      issues.push({
        id: `nav:dead-anchor:${dead}`,
        severity: prodHome && !prodDead ? "high" : "low",
        category: "functional",
        check: "nav-links-health",
        summary:
          prodHome && !prodDead
            ? `Âncora "${dead}" existe no prod mas está morta no candidato (nenhum id/name correspondente)`
            : `Âncora morta "${dead}" — nenhum elemento com esse id/name na página (pré-existente)`,
      });
    }
  }

  // Broken internal nav routes (compare prod vs cand).
  if (prodHome && candHome) {
    const prodResults = await probeRoutes(navLinks(prodHome), prodHome.finalUrl);
    const candResults = await probeRoutes(navLinks(candHome), candHome.finalUrl);
    const prodByPath = new Map(prodResults.map((r) => [r.path, r.status] as const));
    for (const c of candResults) {
      const candBroken = c.status >= 400 || c.status === 0;
      if (!candBroken) continue;
      const prodStatus = prodByPath.get(c.path);
      const prodOk = prodStatus !== undefined && prodStatus >= 200 && prodStatus < 400;
      issues.push({
        id: `nav:broken:${c.path}`,
        severity: prodOk ? "high" : "low",
        category: "functional",
        check: "nav-links-health",
        summary: prodOk
          ? `Link de nav "${c.path}" retornou HTTP ${c.status} no candidato (prod: ${prodStatus}) — regressão`
          : `Link de nav "${c.path}" retornou HTTP ${c.status} (quebrado em ambos — pré-existente)`,
      });
    }
  }

  const status: CheckResult["status"] = issues.some((i) => i.severity === "high")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";
  return {
    name: "nav-links-health",
    status,
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) de navegação`,
    issues,
  };
}

function navLinks(page: PageCapture): NavLink[] {
  const out: NavLink[] = [];
  try {
    const $ = cheerio.load(page.html);
    $("header a[href], nav a[href]").each((_, el) => {
      const href = $(el).attr("href")?.trim();
      if (!href) return;
      out.push({ href, text: $(el).text().trim() });
    });
  } catch {
    /* ignore */
  }
  return out;
}

/** `#foo` links whose target id/name does not exist on the page. */
function deadAnchors(page: PageCapture): string[] {
  const dead: string[] = [];
  try {
    const $ = cheerio.load(page.html);
    const seen = new Set<string>();
    $("header a[href^='#'], nav a[href^='#']").each((_, el) => {
      const href = $(el).attr("href")?.trim();
      if (!href || href === "#" || seen.has(href)) return;
      seen.add(href);
      const id = href.slice(1);
      if (!id) return;
      const exists = $(`#${cssEscape(id)}, [name="${id}"]`).length > 0;
      if (!exists) dead.push(href);
    });
  } catch {
    /* ignore */
  }
  return dead;
}

function cssEscape(id: string): string {
  return id.replace(/[^\w-]/g, "\\$&");
}

async function probeRoutes(
  links: NavLink[],
  base: string,
): Promise<Array<{ path: string; status: number }>> {
  const baseHost = safeHost(base);
  const paths = new Map<string, string>();
  for (const { href } of links) {
    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    let abs: string;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (safeHost(abs) !== baseHost) continue; // internal only
    const path = safePath(abs);
    if (!paths.has(path)) paths.set(path, abs);
  }
  return Promise.all(
    [...paths.entries()].slice(0, 25).map(async ([path, url]) => {
      try {
        const res = await fetch(url, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(8_000),
        });
        return { path, status: res.status };
      } catch {
        return { path, status: 0 };
      }
    }),
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
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
