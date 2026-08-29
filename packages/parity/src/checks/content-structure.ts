import * as cheerio from "cheerio";
import type { CheckResult, Issue, PageCapture } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

/**
 * Content structure parity for editorial pages.
 *
 * A migrated institutional page can carry the right words and still be wrong: the porting step
 * reads the legacy DOM, and legacy stacks rarely mark up the way you expect. VTEX IO writes bold
 * as `<span class="b …strong">`, not `<strong>`, and separates a clause title from its body with
 * `<br>` rather than a paragraph. An extractor that reads `innerText` per paragraph loses both and
 * produces a page whose character count matches exactly — while every heading renders in body
 * weight, glued to the text under it.
 *
 * That failure is invisible to a character diff and to a screenshot score, which is why it gets its
 * own check: count the *structure* (paragraphs, line breaks, bold runs, links), not the prose.
 *
 * Deliberately not a style check. Computed styles are not in a capture; `parity section
 * --computed-styles` drives a live browser for that and is the right tool.
 */

/** Editorial pages only. A PLP losing a `<br>` is noise; a policy page losing 50 is the bug. */
const CONTENT_PATH = /(politica|policy|termos|terminos|terms|tyc|privacidad|privacy|sobre|about|garantia|warranty|institucional|institutional|contacta|contact)/i;

const TOLERANCE = 0.8;

interface Structure {
  chars: number;
  paragraphs: number;
  breaks: number;
  bold: number;
  links: number;
}

/**
 * Bold is counted by rendered intent, not by tag. `<span class="b">` is how VTEX IO emits it, and
 * a class-blind count is exactly the blind spot this check exists to cover.
 */
function readStructure(html: string): Structure {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer").remove();
  const root = $("main").length > 0 ? $("main") : $("body");
  const boldish = root
    .find("strong, b, span, em")
    .filter((_, el) => {
      const tag = (el as { tagName?: string }).tagName?.toLowerCase();
      if (tag === "strong" || tag === "b") return true;
      const cls = String($(el).attr("class") ?? "");
      return /(^|\s)b(\s|$)/.test(cls) || /strong|bold/i.test(cls);
    })
    .length;
  return {
    chars: root.text().replace(/\s+/g, " ").trim().length,
    paragraphs: root.find("p").length,
    breaks: root.find("br").length,
    bold: boldish,
    links: root.find("a[href]").length,
  };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return url;
  }
}

function pair(prod: PageCapture[], cand: PageCapture[]): [PageCapture, PageCapture][] {
  const byPath = new Map<string, PageCapture>();
  for (const c of cand) if (!byPath.has(pathOf(c.url))) byPath.set(pathOf(c.url), c);
  const pairs: [PageCapture, PageCapture][] = [];
  for (const p of prod) {
    const match = byPath.get(pathOf(p.url));
    if (match && CONTENT_PATH.test(pathOf(p.url))) pairs.push([p, match]);
  }
  return pairs;
}

export function contentStructureParity(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const issues: Issue[] = [];
  const pairs = pair(ctx.prodPages, ctx.candPages);

  if (pairs.length === 0) {
    return {
      name: "content-structure",
      status: "skipped",
      severity: "medium",
      durationMs: Date.now() - start,
      summary: "Nenhuma página editorial capturada nos dois lados — comparação de estrutura desabilitada",
      issues: [],
    };
  }

  for (const [prodPage, candPage] of pairs) {
    const path = pathOf(prodPage.url);
    const a = readStructure(prodPage.html);
    const b = readStructure(candPage.html);

    // Nothing to compare against: prod is a stub too, so the candidate is not behind.
    if (a.chars < 500) continue;

    if (b.chars < a.chars * TOLERANCE) {
      issues.push({
        id: `content:missing-body:${path}`,
        severity: "high",
        category: "functional",
        check: "content-structure",
        summary: `${path}: corpo incompleto — ${b.chars} caracteres contra ${a.chars} no prod`,
        details: "A página existe e responde 200, mas o conteúdo não foi migrado por inteiro.",
      });
      continue;
    }

    // Same words, wrong markup — the failure a character diff cannot see.
    const lost: string[] = [];
    if (a.bold > 0 && b.bold < a.bold * TOLERANCE) lost.push(`negrito ${b.bold}/${a.bold}`);
    if (a.breaks > 0 && b.breaks < a.breaks * TOLERANCE) lost.push(`quebras de linha ${b.breaks}/${a.breaks}`);
    if (a.links > 0 && b.links < a.links * TOLERANCE) lost.push(`links ${b.links}/${a.links}`);
    if (a.paragraphs > 0 && b.paragraphs < a.paragraphs * TOLERANCE) {
      lost.push(`parágrafos ${b.paragraphs}/${a.paragraphs}`);
    }

    if (lost.length > 0) {
      issues.push({
        id: `content:lost-formatting:${path}`,
        severity: "medium",
        category: "visual",
        check: "content-structure",
        summary: `${path}: texto migrado sem a formatação — ${lost.join(", ")}`,
        details:
          "O número de caracteres bate, então um diff de texto não acusa. Costuma ser extração por " +
          "`innerText`, que achata `<br>` e perde marcação de negrito quando ela vem por classe " +
          "(`<span class=\"b\">`) em vez de `<strong>`.",
      });
    }
  }

  const status: CheckResult["status"] = issues.some((i) => i.severity === "high")
    ? "fail"
    : issues.length > 0
      ? "warn"
      : "pass";

  return {
    name: "content-structure",
    status,
    severity: "high",
    durationMs: Date.now() - start,
    summary:
      issues.length === 0
        ? `${pairs.length} página(s) editorial(is) com estrutura equivalente ao prod`
        : `${issues.length} página(s) editorial(is) com conteúdo ou formatação faltando`,
    issues,
  };
}
