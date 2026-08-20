import * as cheerio from "cheerio";
import type { CheckResult, Issue, NetworkEntry, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

/**
 * Font parity. A migration can declare the right family in CSS
 * (`--font-sans: 'Lato'`) but ship no `@font-face`/`@import`, so the browser
 * silently falls back to `system-ui`. Screenshots barely move (visual score
 * stayed 92 on portal-davinci) but the brand breaks. We can't read the computed
 * style here (captures don't store it), but the fallback has a reliable
 * fingerprint: prod loads custom font files and the candidate loads none.
 */
export function fontParity(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];

  const prodHome = pickHome(ctx.prodPages);
  const candHome = pickHome(ctx.candPages);
  if (!prodHome || !candHome) {
    return {
      name: "font-parity",
      status: "skipped",
      severity: "high",
      durationMs: Date.now() - start,
      summary: "Falta captura de home em um dos lados — comparação de fontes desabilitada",
      issues: [],
    };
  }

  const prodFonts = countFontRequests(prodHome.network);
  const candFonts = countFontRequests(candHome.network);

  // prod pulls real web fonts, cand pulls none → silent fallback to system font.
  if (prodFonts.total > 0 && candFonts.total === 0) {
    const declared = declaredFamilies(candHome);
    issues.push({
      id: "font:no-font-loaded",
      severity: "high",
      category: "visual",
      check: "font-parity",
      summary: `prod carrega ${prodFonts.total} arquivo(s) de fonte, candidato carrega 0 — provável fallback para fonte de sistema${declared ? ` (CSS declara ${declared})` : ""}`,
      details: `prod fonts:\n${prodFonts.sample.join("\n") || "—"}\n\nDica: falta @font-face/@import para a família declarada. Verifique o app.css.`,
    });
  } else if (prodFonts.total > candFonts.total && candFonts.total > 0) {
    issues.push({
      id: "font:fewer-fonts",
      severity: "medium",
      category: "visual",
      check: "font-parity",
      summary: `Candidato carrega menos fontes que o prod (${candFonts.total} vs ${prodFonts.total}) — pode faltar um peso/estilo`,
    });
  }

  const status: CheckResult["status"] = issues.some((i) => i.severity === "high")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";
  return {
    name: "font-parity",
    status,
    severity: "high",
    durationMs: Date.now() - start,
    summary: `${issues.length} issue(s) de fonte (prod=${prodFonts.total} cand=${candFonts.total} arquivos)`,
    issues,
  };
}

const FONT_HOST_RE = /fonts\.(googleapis|gstatic)\.com|use\.typekit|fonts\.bunny/i;
const FONT_EXT_RE = /\.(woff2?|ttf|otf|eot)(\?|$)/i;

function countFontRequests(network: NetworkEntry[]): { total: number; sample: string[] } {
  const hits = network.filter(
    (n) => n.resourceType === "font" || FONT_EXT_RE.test(n.url) || FONT_HOST_RE.test(n.url),
  );
  return { total: hits.length, sample: hits.slice(0, 5).map((n) => n.url) };
}

/** Best-effort read of the declared font-family from inline CSS / `--font-*` vars. */
function declaredFamilies(page: PageCapture): string | null {
  try {
    const $ = cheerio.load(page.html);
    const css = $("style").text();
    const m = css.match(/--font-[\w-]*:\s*([^;}]+)/) || css.match(/font-family:\s*([^;}]+)/);
    return m?.[1] ? m[1].trim().replace(/["']/g, "") : null;
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
