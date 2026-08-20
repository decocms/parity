import * as cheerio from "cheerio";
import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

/**
 * SSR / no-JS render test. A TanStack candidate that defers every section
 * (all in deferredSections, no `neverDefer`) passes the JS-enabled visual diff
 * with a decent score, but with JS off the page is blank except the footer —
 * high CLS, broken SEO/accessibility. The raw HTML a plain `fetch` returns IS
 * the SSR payload (server markup before hydration), so we measure visible text
 * there. If the candidate's SSR body is near-empty — especially versus prod's —
 * the content is client-only.
 */
export async function ssrNoJs(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];

  const candHome = pickHome(ctx.candPages);
  if (!candHome) {
    return skip(start, "Nenhuma captura de home do candidato");
  }

  const candText = await fetchSsrText(candHome.finalUrl);
  if (candText === null) {
    return skip(start, "Não foi possível baixar o HTML SSR do candidato");
  }

  const prodHome = pickHome(ctx.prodPages);
  const prodText = prodHome ? await fetchSsrText(prodHome.finalUrl) : null;

  if (candText.length < 200) {
    issues.push({
      id: "ssr:blank",
      severity: "critical",
      category: "functional",
      check: "ssr-no-js",
      summary: `SSR do candidato rende só ${candText.length} chars de texto — página em branco sem JS (CLS alto, SEO/acessibilidade quebrados)`,
      details:
        "Todo o conteúdo carrega client-side. Marque seções above-the-fold com `export const neverDefer = true` ou adicione LoadingFallback.",
    });
  } else if (prodText !== null && prodText.length > 0 && candText.length < prodText.length * 0.3) {
    issues.push({
      id: "ssr:thin",
      severity: "high",
      category: "functional",
      check: "ssr-no-js",
      summary: `SSR do candidato tem <30% do texto do prod (${candText.length} vs ${prodText.length} chars) — maioria do conteúdo é client-only`,
    });
  }

  const status: CheckResult["status"] = issues.some((i) => i.severity === "critical")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";
  return {
    name: "ssr-no-js",
    status,
    severity: "critical",
    durationMs: Date.now() - start,
    summary: issues[0]?.summary ?? `SSR OK — candidato rende ${candText.length} chars sem JS`,
    issues,
  };
}

/** Plain fetch = no JS execution → the server-rendered HTML. Strip script/style, read visible text. */
async function fetchSsrText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, template").remove();
    return $("body").text().replace(/\s+/g, " ").trim();
  } catch {
    return null;
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

function skip(start: number, summary: string): CheckResult {
  return {
    name: "ssr-no-js",
    status: "skipped",
    severity: "critical",
    durationMs: Date.now() - start,
    summary,
    issues: [],
  };
}
