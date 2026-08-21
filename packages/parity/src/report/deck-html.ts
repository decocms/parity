/**
 * `renderDeckHtml` — the presentation deck as a single self-contained HTML file. Issue #290.
 *
 * Sibling of `renderHtmlReport` (dark dashboard, one tab per module) and `renderBenchmarkHtml`
 * (light editorial page). This one is the shape you put on a screen in front of the person paying
 * for the migration: one topic per full-viewport page, advanced sideways.
 *
 * Pure — takes a `DeckModel`, returns a string. All CSS/JS comes from `deck-template.ts`.
 */

import type { DeckFinding, DeckModel, DeckTile, I18nText } from "./deck-model.ts";
import { DECK_CSS, DECK_JS } from "./deck-template.ts";

export type DeckLang = "pt" | "en";

const TONE_CLASS: Record<DeckTile["tone"], string> = {
  good: "t-good",
  warn: "t-warn",
  bad: "t-bad",
  neutral: "",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Bilingual span, same contract the templates use: `.i18n` swaps textContent from data-pt/data-en.
 *
 * Both locales are asserted non-empty. A blank one is invisible until someone flips the toggle, and
 * then it renders as an empty label — so it fails here instead, at render time. `same()` is the
 * escape hatch for the cases where one string legitimately serves both. Issue #293.
 */
function L(pt: string, en: string, lang: DeckLang): string {
  if (!pt.trim() || !en.trim()) {
    throw new Error(
      `deck i18n: both locales required, got pt=${JSON.stringify(pt)} en=${JSON.stringify(en)}. Use same("...") when one string serves both.`,
    );
  }
  const initial = lang === "pt" ? pt : en;
  return `<span class="i18n" data-pt="${esc(pt)}" data-en="${esc(en)}">${esc(initial)}</span>`;
}

/** Render an {@link I18nText} from the model. */
function T(text: I18nText, lang: DeckLang): string {
  return L(text.pt, text.en, lang);
}

function tiles(items: DeckTile[], lang: DeckLang): string {
  const cells = items
    .map(
      (t) =>
        `<div class="tile"><div class="tile-val ${TONE_CLASS[t.tone]}">${esc(t.value)}</div><div class="tile-label">${T(
          t.label,
          lang,
        )}</div>${t.sub ? `<div class="tile-sub">${T(t.sub, lang)}</div>` : ""}</div>`,
    )
    .join("");
  return `<div class="stat-grid">${cells}</div>`;
}

function page(eyebrow: string, title: string, body: string, note?: string): string {
  return `<section class="page"><div class="page-inner">
    <div class="eyebrow">${eyebrow}</div>
    <h2 class="page-title">${title}</h2>
    ${note ? `<p class="annotation">${note}</p>` : ""}
    ${body}
  </div></section>`;
}

function findingsTable(findings: DeckFinding[], omitted: number, lang: DeckLang): string {
  if (findings.length === 0) {
    return `<p class="annotation">${L(
      "Nenhum achado ranqueado neste run.",
      "No ranked findings in this run.",
      lang,
    )}</p>`;
  }
  const rows = findings
    .map((f) => {
      const pill =
        f.severity === "critical" || f.severity === "high"
          ? f.severity === "critical"
            ? "pill-bad"
            : "pill-warn"
          : "pill-good";
      // An inconclusive finding is labelled, never presented as a defect (#292).
      const badge = f.inconclusive
        ? ` <span class="pill pill-warn">${L("inconclusivo", "inconclusive", lang)}</span>`
        : "";
      return `<tr><td><span class="pill ${pill}">${esc(f.severity)}</span>${badge}</td><td>${esc(
        f.category,
      )}</td><td>${esc(f.summary)}</td></tr>`;
    })
    .join("");
  // Never let a cap read as "that was everything".
  const tail =
    omitted > 0
      ? `<p class="annotation">${L(
          `+${omitted} achado(s) além dos mostrados — veja report.json.`,
          `+${omitted} more finding(s) beyond those shown — see report.json.`,
          lang,
        )}</p>`
      : "";
  return `<table class="grid compact"><thead><tr><th>${L("Sev", "Sev", lang)}</th><th>${L(
    "Categoria",
    "Category",
    lang,
  )}</th><th>${L("Achado", "Finding", lang)}</th></tr></thead><tbody>${rows}</tbody></table>${tail}`;
}

export function renderDeckHtml(model: DeckModel, lang: DeckLang = "en"): string {
  const pages: string[] = [];

  // 1 — cover
  pages.push(`<section class="page cover"><div class="page-inner">
    <div class="eyebrow">${L("Relatório de migração", "Migration report", lang)}</div>
    <h1 class="cover-h1">${esc(hostOf(model.candUrl))}<br/><span class="dim">${esc(
      hostOf(model.prodUrl),
    )}</span> → <span class="lime-ink">${esc(hostOf(model.candUrl))}</span></h1>
    <div class="cover-meta">
      <div><b>${model.score}</b><small>${L("score parity", "parity score", lang)}</small></div>
      <div><b>${esc(model.status)}</b><small>${L("veredito", "verdict", lang)}</small></div>
      <div><b>${esc(model.timestamp.slice(0, 10))}</b><small>${L("data", "date", lang)}</small></div>
    </div>
    <p class="hint">${L(
      "Use ← → ou role a página — o scroll avança lateralmente.",
      "Use ← → or scroll — the deck advances sideways.",
      lang,
    )}</p>
  </div></section>`);

  // 2 — how to read this run (only when there is something to say)
  if (model.caveats.length > 0) {
    const rows = model.caveats
      .map(
        (c) =>
          `<tr><td><span class="pill ${
            c.level === "warn" ? "pill-warn" : "pill-good"
          }">${esc(c.level)}</span></td><td><b>${esc(c.summary)}</b></td><td>${esc(c.detail)}</td></tr>`,
      )
      .join("");
    pages.push(
      page(
        L("Contexto", "Context", lang),
        L("Como ler este run", "How to read this run", lang),
        `<table class="grid"><tbody>${rows}</tbody></table>`,
        L(
          "O que o número <b>não</b> mede. Vem de <code>report.json.caveats</code>.",
          "What the number does <b>not</b> measure. From <code>report.json.caveats</code>.",
          lang,
        ),
      ),
    );
  }

  // 3 — summary
  const moduleRows = model.modules
    .map(
      (m) =>
        `<tr><td>${esc(m.module)}</td><td><b class="num">${m.score}</b></td><td><span class="pill pill-${
          m.tone === "good" ? "good" : m.tone === "warn" ? "warn" : "bad"
        }">${esc(m.status)}</span></td></tr>`,
    )
    .join("");
  pages.push(
    page(
      L("Sumário executivo", "Executive summary", lang),
      L("Onde a migração está", "Where the migration stands", lang),
      tiles(model.headline, lang) +
        (moduleRows
          ? `<h3 class="sub">${L("Score por módulo", "Score per module", lang)}</h3>` +
            `<table class="grid"><tbody>${moduleRows}</tbody></table>`
          : ""),
    ),
  );

  // 4 — findings
  pages.push(
    page(
      L("Achados", "Findings", lang),
      L("O que a validação encontrou", "What the validation found", lang),
      findingsTable(model.findings, model.findingsOmitted, lang),
    ),
  );

  // 5 — visual, when the module ran
  if (model.visual) {
    pages.push(
      page(
        L("Visual", "Visual", lang),
        L("Paridade visual", "Visual parity", lang),
        tiles(
          [
            {
              value: String(model.visual.pagesChecked),
              label: { pt: "páginas comparadas", en: "pages compared" },
              sub: null,
              tone: "neutral",
            },
            {
              value: String(model.visual.pagesPassed),
              label: { pt: "sem diferenças", en: "no differences" },
              sub: null,
              tone: "good",
            },
            {
              value: String(model.visual.pagesWithDiffs),
              label: { pt: "com diferenças", en: "with differences" },
              sub: null,
              tone: model.visual.pagesWithDiffs > 0 ? "warn" : "good",
            },
          ],
          lang,
        ),
      ),
    );
  }

  return `<!doctype html>
<html lang="${lang === "pt" ? "pt-BR" : "en"}"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>parity deck — ${esc(model.runId)}</title>
<style>${DECK_CSS}</style>
</head><body>
<div class="nav">
  <b>parity · ${esc(hostOf(model.candUrl))}</b>
  <span class="spacer"></span>
  <div class="dots"><!-- filled by DECK_JS, one per page --></div>
  <span class="counter"></span>
  <button class="lang-toggle" id="langToggle" type="button">${lang === "pt" ? "EN" : "PT"}</button>
</div>
<main class="deck">${pages.join("")}</main>
<script>${DECK_JS}</script>
</body></html>`;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}
