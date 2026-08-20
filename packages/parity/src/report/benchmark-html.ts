// Single self-contained HTML report for `parity benchmark` — the client-facing
// "User Navigation Benchmark" deliverable. Every screenshot is inlined as a
// base64 data URI (pattern from src/migrate/exporters/html.ts) so the file can
// be shared as one attachment with no external assets. Visual language mirrors
// the deco diagnostic "Relatório" deck (white paper, ink text, soft-green
// accents, oversized editorial numbers). A PT/EN toggle flips all copy live.
import { readFileSync } from "node:fs";
import type { BenchmarkReport, SideBenchmark, StepTiming } from "../engine/benchmark.ts";
import type { LhResult } from "../engine/lighthouse.ts";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function dataUri(absPath: string | undefined): string | null {
  if (!absPath) return null;
  try {
    const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase();
    const mime = MIME[ext];
    if (!mime) return null;
    return `data:${mime};base64,${readFileSync(absPath).toString("base64")}`;
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Bilingual text node — JS swaps `.textContent` from the active lang's data-attr. */
function L(pt: string, en: string, lang: string): string {
  return `<span class="i18n" data-pt="${esc(pt)}" data-en="${esc(en)}">${esc(lang === "en" ? en : pt)}</span>`;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const STEP_LABELS: Record<string, { pt: string; en: string }> = {
  "home-load": { pt: "Carregar a home", en: "Home load" },
  "home-to-plp": { pt: "Home → listagem (PLP)", en: "Home → listing (PLP)" },
  pagination: { pt: "Paginação (scroll)", en: "Pagination (scroll)" },
  "pdp-entry": { pt: "Entrar no produto (PDP)", en: "Enter product (PDP)" },
  "shelf-nav": { pt: "Produto → produto (SPA na shelf)", en: "Product → product (SPA shelf)" },
  "variant-switch": { pt: "Trocar variante", en: "Switch variant" },
};

// step key → which screenshot illustrates it
const STEP_SHOT: Record<string, keyof SideBenchmark["screenshots"]> = {
  "home-load": "home",
  "home-to-plp": "plp",
  pagination: "plpPaginated",
  "pdp-entry": "pdp",
  "shelf-nav": "shelf",
  "variant-switch": "pdpVariant",
};

// ── Design tokens (deco diagnostic deck) ─────────────────────────────────────
const DECK = {
  bg: "#ffffff",
  ink: "#282524",
  muted: "#78726e",
  faint: "#a6a09d",
  border: "rgba(40,37,36,0.09)",
  cardBorder: "rgba(40,37,36,0.06)",
  soft: "#8caa25",
  limeTint: "#eff6cc",
  forest: "#07401a",
  warn: "#f0b613",
  bad: "#d43d3d",
};

export function speedup(prodMs: number, candMs: number): number {
  return candMs > 0 ? prodMs / candMs : 0;
}

/** tone for a "lower is better" comparison of cand vs prod */
export function deltaTone(prodMs: number, candMs: number): string {
  if (prodMs <= 0 || candMs <= 0) return DECK.muted;
  if (candMs < prodMs * 0.95) return DECK.soft; // meaningfully faster
  if (candMs > prodMs * 1.05) return DECK.bad; // meaningfully slower
  return DECK.warn; // roughly even
}

/** signed percent change of cand vs prod, e.g. "-42%" (cand faster). */
export function pctChange(prodMs: number, candMs: number): string {
  if (prodMs <= 0 || candMs <= 0) return "—";
  const change = ((candMs - prodMs) / prodMs) * 100;
  const sign = change > 0 ? "+" : "";
  return `${sign}${change.toFixed(0)}%`;
}

// ── framed screenshot (the "imagens em destaque" payoff) ─────────────────────
// When `href` is set the label pill becomes a link to the exact page tested on
// that side (opens in a new tab). `scroll` renders a tall full-page capture in a
// fixed-height, scrollable, phone-like frame so the whole print is viewable.
function figure(
  path: string | undefined,
  labelHtml: string,
  tone: string,
  href?: string,
  scroll = false,
): string {
  const uri = dataUri(path);
  const inner = uri
    ? `<img src="${uri}" alt="" loading="lazy"/>`
    : `<div class="shot-missing">—</div>`;
  const tag = href
    ? `<a class="shot-tag" style="background:${tone}" href="${esc(href)}" target="_blank" rel="noreferrer">${labelHtml} ↗</a>`
    : `<span class="shot-tag" style="background:${tone}">${labelHtml}</span>`;
  return `<figure class="shot${scroll ? " shot-scroll" : ""}">${tag}<div class="shot-view">${inner}</div></figure>`;
}

// ── one step: bilingual title, prod/cand bars, prod/cand screenshots ─────────
function renderStep(
  step: StepTiming,
  prod: SideBenchmark,
  cand: SideBenchmark,
  lang: string,
): string {
  const prodStep = prod.steps.find((s) => s.step === step.step);
  const candStep = cand.steps.find((s) => s.step === step.step);
  const p = prodStep?.ms ?? 0;
  const c = candStep?.ms ?? 0;
  const max = Math.max(p, c, 1);
  const label = STEP_LABELS[step.step] ?? { pt: step.step, en: step.step };
  const tone = deltaTone(p, c);
  // Commerce steps map to fixed slots; content steps are keyed by the step name
  // itself (e.g. nav-especialidades) — fall back to that so their shots render.
  const shotKey = STEP_SHOT[step.step] ?? step.step;
  // Full-page prints scroll inside a phone-like frame.
  const scroll = true;

  // A step that didn't apply (e.g. product has no colour variant) — render the
  // note, not a misleading 0ms bar.
  const naNote = candStep?.ms === 0 ? candStep.note : undefined;
  if (naNote) {
    return `
  <section class="step">
    <div class="step-head"><h3>${L(label.pt, label.en, lang)}</h3></div>
    <div class="step-note">${L(naNote, naNote, lang)}</div>
  </section>`;
  }

  const bar = (ms: number, who: string, color: string) => `
    <div class="bar-row">
      <span class="bar-who">${who}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(ms / max) * 100}%;background:${color}"></div></div>
      <span class="bar-val" style="color:${color}">${fmtMs(ms)}</span>
    </div>`;

  // Pagination broken down PER PAGE and PER TECHNOLOGY: each scroll (#1, #2…)
  // shows Fresh vs TanStack side by side, so you see which page loaded faster on
  // each stack. Bars share one scale across all pages for honest comparison.
  const subSteps = (() => {
    if (step.step !== "pagination") return "";
    const n = Math.max(prod.paginationSteps.length, cand.paginationSteps.length);
    if (n === 0) return "";
    const allMs = [...prod.paginationSteps, ...cand.paginationSteps].map((s) => s.ms);
    const m = Math.max(1, ...allMs);
    const rows = Array.from({ length: n }, (_, i) => {
      const pp = prod.paginationSteps[i]?.ms ?? 0;
      const cp = cand.paginationSteps[i]?.ms ?? 0;
      const note = cand.paginationSteps[i]?.note ?? prod.paginationSteps[i]?.note ?? "";
      const bar2 = (ms: number, who: string, color: string) =>
        `<div class="subrow"><span class="subrow-who">${who}</span><div class="bar-track"><div class="bar-fill" style="width:${(ms / m) * 100}%;background:${color}"></div></div><span class="bar-val">${fmtMs(ms)}</span></div>`;
      return `<div class="subpage">
        <div class="subpage-label">${L(`Página ${i + 1}`, `Page ${i + 1}`, lang)}${note ? ` <span class="subpage-note">${esc(note)}</span>` : ""}</div>
        ${bar2(pp, "Fresh", DECK.faint)}
        ${bar2(cp, "TanStack", DECK.soft)}
      </div>`;
    }).join("");
    return `<div class="subbars">${rows}</div>`;
  })();

  // A side that failed (broken/not-found page, pagination didn't advance…) — do
  // NOT present the delta as a win. Flag it red and show which side broke.
  const prodFailed = prodStep?.ok === false;
  const candFailed = candStep?.ok === false;
  const failed = prodFailed || candFailed;
  const failNote = (candFailed ? candStep?.note : prodStep?.note) ?? "";
  const delta = failed
    ? `<div class="step-delta"><strong style="color:${DECK.bad}">⚠ ${L("erro", "error", lang)}</strong>
         <span class="step-delta-sub">${L(candFailed ? "TanStack falhou" : "Fresh falhou", candFailed ? "TanStack failed" : "Fresh failed", lang)}</span></div>`
    : `<div class="step-delta" style="color:${tone}"><strong>${pctChange(p, c)}</strong>
         <span class="step-delta-sub">${L("vs. Fresh", "vs. Fresh", lang)}</span></div>`;

  return `
  <section class="step${failed ? " step-failed" : ""}">
    <div class="step-head">
      <h3>${L(label.pt, label.en, lang)}</h3>
      ${delta}
    </div>
    <div class="step-bars">
      ${bar(p, "Fresh", prodFailed ? DECK.bad : DECK.faint)}
      ${bar(c, "TanStack", candFailed ? DECK.bad : DECK.soft)}
      ${subSteps}
    </div>
    ${failed ? `<div class="step-note step-note-err">⚠ ${L(failNote, failNote, lang)}</div>` : candStep?.note ? `<div class="step-note">${L(candStep.note, candStep.note, lang)}</div>` : ""}
    <div class="step-shots">
      ${figure(shotKey ? prod.screenshots[shotKey] : undefined, "Fresh", prodFailed ? DECK.bad : DECK.faint, prodStep?.url, scroll)}
      ${figure(shotKey ? cand.screenshots[shotKey] : undefined, "TanStack", candFailed ? DECK.bad : DECK.soft, candStep?.url, scroll)}
    </div>
  </section>`;
}

// ── Lighthouse vitals table ──────────────────────────────────────────────────
function fmtVital(metric: string, v: number | null): string {
  if (v === null || v === undefined) return "—";
  if (metric === "cls") return v.toFixed(3);
  return fmtMs(v);
}

function vitalCell(metric: string, prod: LhResult, cand: LhResult): string {
  const pv = "error" in prod ? null : (prod[metric as keyof typeof prod] as number | null);
  const cv = "error" in cand ? null : (cand[metric as keyof typeof cand] as number | null);
  const tone = pv !== null && cv !== null ? deltaTone(pv, cv) : DECK.muted;
  return `<td><span class="v-prod">${fmtVital(metric, pv)}</span><span class="v-arrow">→</span><span class="v-cand" style="color:${tone}">${fmtVital(metric, cv)}</span></td>`;
}

function renderVitals(prod: SideBenchmark, cand: SideBenchmark, lang: string): string {
  const rows = (["home", "plp", "pdp"] as const)
    .map((page) => {
      const pageLabel = { home: "Home", plp: "PLP", pdp: "PDP" }[page];
      return `<tr>
        <th>${pageLabel}</th>
        ${vitalCell("lcp", prod.vitals[page], cand.vitals[page])}
        ${vitalCell("fcp", prod.vitals[page], cand.vitals[page])}
        ${vitalCell("ttfb", prod.vitals[page], cand.vitals[page])}
        ${vitalCell("tbt", prod.vitals[page], cand.vitals[page])}
        ${vitalCell("cls", prod.vitals[page], cand.vitals[page])}
      </tr>`;
    })
    .join("");
  const ff = prod.viewport === "desktop" ? "desktop" : "mobile";
  return `
  <div class="vitals">
    <div class="eyebrow">${L("MÉTRICAS DE LABORATÓRIO", "LAB METRICS", lang)}</div>
    <h2>Web Vitals (Lighthouse ${ff})</h2>
    <p class="annotation">${L("Primeira visita fria — Fresh → TanStack por página. Distinto dos tempos de navegação aquecida acima.", "Cold first visit — Fresh → TanStack per page. Distinct from the warm navigation timings above.", lang)}</p>
    <table>
      <thead><tr><th></th><th>LCP</th><th>FCP</th><th>TTFB</th><th>TBT</th><th>CLS</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ── one viewport block ───────────────────────────────────────────────────────
function renderViewport(report: BenchmarkReport, viewport: string, lang: string): string {
  const prod = report.sides.find((s) => s.viewport === viewport && s.side === "prod");
  const cand = report.sides.find((s) => s.viewport === viewport && s.side === "cand");
  if (!prod || !cand) return "";

  const su = speedup(prod.totalMs, cand.totalMs);
  const suLabel = su >= 1 ? `${su.toFixed(1)}×` : `${su.toFixed(2)}×`;

  // Drop the "not applicable" variant step entirely (e.g. single-colour product)
  // — the user doesn't want a dead tile/section when there's nothing to switch.
  const visibleSteps = cand.steps.filter((cs) => !(cs.ms === 0 && cs.step === "variant-switch"));

  const statTiles = visibleSteps
    .map((cs) => {
      const ps = prod.steps.find((s) => s.step === cs.step);
      const p = ps?.ms ?? 0;
      const label = STEP_LABELS[cs.step] ?? { pt: cs.step, en: cs.step };
      const tone = deltaTone(p, cs.ms);
      return `<div class="tile">
        <span class="tile-val" style="color:${tone}">${fmtMs(cs.ms)}</span>
        <span class="tile-label">${L(label.pt, label.en, lang)}</span>
        <span class="tile-sub">${L(`antes (Fresh): ${fmtMs(p)}`, `before (Fresh): ${fmtMs(p)}`, lang)} · <b style="color:${tone}">${pctChange(p, cs.ms)}</b></span>
      </div>`;
    })
    .join("");

  const steps = visibleSteps.map((s) => renderStep(s, prod, cand, lang)).join("");
  const vitals = report.runVitals ? renderVitals(prod, cand, lang) : "";

  return `
  <div class="viewport" data-vp="${viewport}">
    <div class="hero">
      <div class="hero-nums">
        <div class="eyebrow">${L("TEMPO TOTAL DA JORNADA", "TOTAL JOURNEY TIME", lang)}</div>
        <div class="hero-total">
          <div class="ht-side"><span class="ht-num" style="color:${DECK.faint}">${fmtMs(prod.totalMs)}</span><span class="ht-cap">Fresh</span></div>
          <span class="ht-arrow">→</span>
          <div class="ht-side"><span class="ht-num" style="color:${DECK.soft}">${fmtMs(cand.totalMs)}</span><span class="ht-cap">TanStack</span></div>
        </div>
        <div class="hero-speedup"><span class="hs-big">${suLabel}</span> ${L("mais rápido", "faster", lang)}</div>
      </div>
      ${figure(cand.screenshots.home, "TanStack", DECK.soft, cand.base, true)}
    </div>

    <div class="eyebrow section-eyebrow">${L("OS CINCO PASSOS, LADO A LADO", "THE FIVE STEPS, SIDE BY SIDE", lang)}</div>
    <div class="stat-grid">${statTiles}</div>

    <div class="steps">${steps}</div>

    ${vitals}
  </div>`;
}

/** A prominent banner listing any step that failed on either side — so a broken
 *  page can't hide behind a green "faster" number. Empty when everything passed. */
function failureBanner(report: BenchmarkReport, lang: string): string {
  const fails: string[] = [];
  for (const s of report.sides) {
    for (const step of s.steps) {
      // Skip the intentional "not applicable" variant (ms 0 but ok).
      if (step.ok === false) {
        const label = STEP_LABELS[step.step] ?? { pt: step.step, en: step.step };
        const who = s.side === "cand" ? "TanStack" : "Fresh";
        fails.push(`${who} · ${lang === "en" ? label.en : label.pt}: ${step.note ?? "erro"}`);
      }
    }
  }
  if (fails.length === 0) return "";
  const items = fails.map((f) => `<li>${esc(f)}</li>`).join("");
  return `<div class="warn-banner">
    <b>⚠ ${L("Atenção — passos com erro", "Warning — steps that failed", lang)}:</b>
    ${L("os tempos abaixo NÃO são confiáveis para estes passos (página de erro / rota inexistente / paginação que não avançou).", "the timings below are NOT reliable for these steps (error page / missing route / pagination that didn't advance).", lang)}
    <ul style="margin:8px 0 0;padding-left:18px">${items}</ul>
  </div>`;
}

/** The (i) modal — the EXACT methodology, answering "por tempo? só timefall?
 *  click→primeira imagem? com média?". Must mirror the real driver. */
function methodologyModal(report: BenchmarkReport, lang: string): string {
  const pt = `
    <h3>1. Batedor (uma vez)</h3>
    <p>Um explorador valida, no navegador, uma categoria (PLP) e um produto (PDP) que <b>funcionam nos DOIS sites</b> — renderizam produto de verdade, sem página de erro. As MESMAS páginas são usadas nos dois lados.</p>
    <h3>2. Visitante recorrente (aquecimento)</h3>
    <p>Cada lado roda o fluxo <code>${report.warmupRuns}×</code> antes de medir, aquecendo a borda (Cloudflare) <b>e o cache do navegador</b> — no mesmo contexto. Assim o bundle JS do SPA e os assets já estão em cache na hora de medir, como um cliente que já visitou antes.</p>
    <h3>3. Medição — por TEMPO, não pelo HAR</h3>
    <p>Medimos <b>tempo de relógio (wall-clock)</b>, não o waterfall do HAR. Para cada navegação, o cronômetro começa <b>no clique</b> e para <b>quando a primeira imagem de produto da página de destino renderiza</b> (decodificada, ≥120px). É o tempo que o usuário realmente percebe.</p>
    <ul>
      <li><b>Home</b>: abrir a home → 1ª imagem renderizar.</li>
      <li><b>Home → PLP</b>: abrir o menu → categoria → 1ª imagem da listagem.</li>
      <li><b>Paginação</b>: rolar até o fim → tempo até os PRÓXIMOS produtos aparecerem (não é o scroll, é a carga).</li>
      <li><b>Entrar na PDP</b> e <b>Produto → produto (shelf)</b>: clique → 1ª imagem do produto. O hover/prefetch acontece ANTES e não entra na conta.</li>
      <li><b>Variante</b>: só aparece quando o produto tem variante de cor (trocar cor = navegar), senão é omitida.</li>
    </ul>
    <p>O hover (que dispara o prefetch do SPA) é aplicado igual nos dois sites e fica FORA do tempo — medimos só o clique→conteúdo.</p>
    <h3>4. Média</h3>
    <p>Cada número é a <b>mediana de ${report.measuredRuns} medição(ões)</b> por lado, para cortar variância. O HAR completo da sessão fica salvo como artefato forense.</p>`;
  const en = `
    <h3>1. Scout (once)</h3>
    <p>An explorer validates, in the browser, a category (PLP) and a product (PDP) that <b>work on BOTH sites</b> — they render a real product, no error page. The SAME pages are used on both sides.</p>
    <h3>2. Returning visitor (warmup)</h3>
    <p>Each side runs the flow <code>${report.warmupRuns}×</code> before measuring, warming the edge (Cloudflare) <b>and the browser cache</b> in the same context. So the SPA's JS bundle and assets are already cached at measure time, like a shopper who has visited before.</p>
    <h3>3. Measurement — by TIME, not the HAR</h3>
    <p>We measure <b>wall-clock time</b>, not the HAR waterfall. For each navigation the clock starts <b>at the click</b> and stops <b>when the first product image of the destination renders</b> (decoded, ≥120px) — the time a user actually perceives.</p>
    <ul>
      <li><b>Home</b>: open home → first image renders.</li>
      <li><b>Home → PLP</b>: open menu → category → first listing image.</li>
      <li><b>Pagination</b>: scroll to the end → time until the NEXT products appear (the load, not the scroll).</li>
      <li><b>Enter PDP</b> and <b>Product → product (shelf)</b>: click → first product image. The hover/prefetch happens BEFORE and is excluded.</li>
      <li><b>Variant</b>: shown only when the product has a colour variant (switching colour = a navigation), otherwise omitted.</li>
    </ul>
    <p>The hover (which triggers the SPA prefetch) is applied identically on both sides and kept OUT of the timing — we measure only click→content.</p>
    <h3>4. Median</h3>
    <p>Each number is the <b>median of ${report.measuredRuns} measurement(s)</b> per side, to cut variance. The full session HAR is saved as a forensic artifact.</p>`;
  return `<div class="modal-back" id="infoModal">
    <div class="modal">
      <button class="mclose" id="infoClose" type="button" aria-label="fechar">×</button>
      <h2>${L("Como este benchmark é medido", "How this benchmark is measured", lang)}</h2>
      <div class="i18n-html" data-pt="${esc(pt)}" data-en="${esc(en)}">${lang === "en" ? en : pt}</div>
    </div>
  </div>`;
}

export function renderBenchmarkHtml(report: BenchmarkReport, opts: { lang: string }): string {
  const lang = opts.lang === "en" ? "en" : "pt";
  // Date + time (UTC → local-ish "YYYY-MM-DD HH:MM"). The user wanted the time.
  const stamp = `${report.timestamp.slice(0, 10)} ${report.timestamp.slice(11, 16)}`;
  const multiVp = report.viewports.length > 1;
  const viewports = report.viewports
    .map(
      (v, i) =>
        `<div class="vp-panel" data-vp="${v}"${i === 0 ? "" : " hidden"}>${renderViewport(report, v, lang)}</div>`,
    )
    .join("");
  const vpTabs = multiVp
    ? `<div class="vp-tabs">${report.viewports
        .map(
          (v, i) =>
            `<button type="button" class="vp-tab${i === 0 ? " active" : ""}" data-vp="${v}">${v === "desktop" ? "🖥️ Desktop" : "📱 Mobile"}</button>`,
        )
        .join("")}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>User Navigation Benchmark — ${esc(domainOf(report.candUrl))}</title>
${report.favicon ? `<link rel="icon" href="${esc(report.favicon)}"/>` : ""}
<style>
  :root{
    --bg:${DECK.bg};--ink:${DECK.ink};--muted:${DECK.muted};--faint:${DECK.faint};
    --border:${DECK.border};--card:${DECK.cardBorder};--soft:${DECK.soft};--forest:${DECK.forest};
  }
  *{box-sizing:border-box}
  html{background:#e9e7e3}
  body{margin:0;color:var(--ink);background:var(--bg);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    line-height:1.5;-webkit-font-smoothing:antialiased;
    max-width:1080px;margin:0 auto;padding:0 20px 80px}
  .num{font-family:Georgia,"Times New Roman",serif;font-weight:400;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}
  .eyebrow{font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:var(--soft)}
  h1,h2,h3{font-weight:400;letter-spacing:-0.02em;margin:0}
  .annotation{color:var(--muted);font-size:14px;margin:6px 0 0}

  /* top bar */
  .topbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:14px;
    padding:16px 0;background:rgba(255,255,255,0.9);backdrop-filter:blur(8px);
    border-bottom:1px solid var(--border);margin-bottom:8px}
  .topbar .fav{width:34px;height:34px;border-radius:9px;border:1px solid var(--card);background:#fff;padding:5px;object-fit:contain}
  .topbar .brand{display:flex;flex-direction:column}
  .topbar .brand b{font-size:15px}
  .topbar .brand small{color:var(--muted);font-size:12px}
  .cover-logo{max-height:48px;max-width:200px;object-fit:contain;margin-bottom:6px}
  .topbar .spacer{flex:1}
  .lang-toggle{border:1px solid rgba(40,37,36,0.18);background:#fff;border-radius:999px;
    padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer;color:var(--ink)}
  .lang-toggle:hover{background:#faf9f7}

  /* cover */
  .cover{padding:48px 0 24px;border-bottom:1px solid var(--border)}
  .cover .kicker{color:var(--faint);font-size:13px;margin-top:10px}
  .cover h1{font-size:clamp(2rem,5vw,3.2rem);line-height:1.05;margin-top:14px}
  .cover .sites{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px;color:var(--muted);font-size:14px}
  .cover .sites b{color:var(--ink)}

  /* viewport */
  .viewport{padding-top:36px}
  .vp-badge{display:inline-block;font-size:12px;font-weight:600;color:var(--muted);
    background:#f4f2ef;border:1px solid var(--border);border-radius:999px;padding:4px 12px;margin-bottom:8px}

  /* hero */
  .hero{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:center;
    padding:28px 0 8px}
  .hero-total{display:flex;align-items:flex-end;gap:20px;margin-top:12px}
  .ht-side{display:flex;flex-direction:column}
  .ht-num{font-family:Georgia,serif;font-size:clamp(2.4rem,7vw,4.4rem);line-height:0.95;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}
  .ht-cap{font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:var(--muted);margin-top:6px}
  .ht-arrow{font-size:2rem;color:var(--faint);padding-bottom:18px}
  .hero-speedup{margin-top:22px;font-size:16px;color:var(--muted)}
  .hero-speedup .hs-big{font-family:Georgia,serif;font-size:2rem;color:var(--forest);letter-spacing:-0.02em}

  /* framed screenshot */
  .shot{margin:0;position:relative;border-radius:16px;overflow:hidden;background:#f6f4f1;
    border:1px solid var(--card);
    box-shadow:0 1px 2px rgba(40,37,36,0.04),0 12px 34px rgba(40,37,36,0.08)}
  .shot img{display:block;width:100%;height:auto}
  .shot-view{position:relative}
  /* full-page print: fixed-height, scrollable phone-like frame */
  .shot-scroll .shot-view{max-height:70vh;overflow-y:auto;-webkit-overflow-scrolling:touch;scroll-behavior:smooth}
  .shot-scroll .shot-view::-webkit-scrollbar{width:8px}
  .shot-scroll .shot-view::-webkit-scrollbar-thumb{background:rgba(40,37,36,0.22);border-radius:8px}
  .shot-scroll::after{content:"↕ scroll";position:absolute;bottom:10px;right:10px;z-index:2;
    font-size:10px;font-weight:700;letter-spacing:0.04em;color:#fff;background:rgba(40,37,36,0.55);
    padding:3px 8px;border-radius:999px;pointer-events:none}
  .shot-tag{position:absolute;top:12px;left:12px;z-index:3;color:#fff;font-size:11px;font-weight:700;
    letter-spacing:0.04em;padding:4px 10px;border-radius:999px;text-decoration:none}
  a.shot-tag{transition:filter .15s}
  a.shot-tag:hover{filter:brightness(1.08)}
  .shot-missing{aspect-ratio:1/1;display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:24px}
  .step-note{margin-top:12px;font-size:13px;color:var(--muted);background:#faf9f7;border:1px solid var(--card);border-radius:8px;padding:8px 12px}

  /* stat grid */
  .section-eyebrow{margin:40px 0 14px}
  .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px}
  .tile{display:flex;flex-direction:column;gap:6px;padding:20px;border:1px solid var(--card);border-radius:14px;background:#fff}
  .tile-val{font-family:Georgia,serif;font-size:clamp(1.8rem,4vw,2.6rem);line-height:1;letter-spacing:-0.02em;font-variant-numeric:tabular-nums}
  .tile-label{font-size:14px;color:var(--ink)}
  .tile-sub{font-size:12px;color:var(--muted)}

  /* steps */
  .steps{margin-top:36px;display:flex;flex-direction:column;gap:26px}
  .step{border:1px solid var(--card);border-radius:16px;padding:22px;background:#fff}
  .step-head{display:flex;justify-content:space-between;align-items:baseline;gap:16px}
  .step-head h3{font-size:19px}
  .step-delta{text-align:right;white-space:nowrap}
  .step-delta strong{font-family:Georgia,serif;font-size:1.5rem}
  .step-delta-sub{display:block;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em}
  .step-bars{margin:16px 0 20px;display:flex;flex-direction:column;gap:10px}
  .bar-row,.subbar{display:grid;grid-template-columns:74px 1fr 64px;align-items:center;gap:12px}
  .bar-who{font-size:12px;font-weight:600;color:var(--muted)}
  .bar-track{height:12px;background:#f0eeeb;border-radius:999px;overflow:hidden}
  .bar-fill{height:100%;border-radius:999px;transition:width .6s ease}
  .bar-val{font-size:13px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ink)}
  .subbars{margin-top:6px;padding-top:12px;border-top:1px dashed var(--border);display:flex;flex-direction:column;gap:14px}
  .subpage-label{font-size:12px;font-weight:600;color:var(--muted);margin-bottom:5px}
  .subpage-note{font-weight:400;color:var(--faint);font-size:11px}
  .subrow{display:grid;grid-template-columns:74px 1fr 64px;align-items:center;gap:12px;margin-bottom:4px}
  .subrow-who{font-size:12px;font-weight:600;color:var(--muted)}
  .step-shots{display:grid;grid-template-columns:1fr 1fr;gap:14px}

  /* vitals */
  .vitals{margin-top:44px;padding-top:28px;border-top:1px solid var(--border)}
  .vitals h2{font-size:22px;margin-top:6px}
  .vitals table{width:100%;border-collapse:collapse;margin-top:18px;font-size:14px}
  .vitals th,.vitals td{text-align:left;padding:12px 10px;border-bottom:1px solid var(--border)}
  .vitals thead th{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);font-weight:600}
  .vitals tbody th{font-weight:600}
  .v-prod{color:var(--faint)}.v-arrow{color:var(--faint);margin:0 6px}
  .v-cand{font-weight:600;font-variant-numeric:tabular-nums}

  /* failures */
  .step-failed{border-color:rgba(212,61,61,0.35);box-shadow:0 0 0 1px rgba(212,61,61,0.12) inset}
  .step-note-err{background:rgba(212,61,61,0.06);border-color:rgba(212,61,61,0.25);color:#a5302f}
  .warn-banner{margin:18px 0 4px;padding:14px 18px;border-radius:14px;background:rgba(212,61,61,0.07);
    border:1px solid rgba(212,61,61,0.3);color:#a5302f;font-size:14px;line-height:1.55}
  .warn-banner b{color:#8f2624}

  /* footer */
  .method{margin-top:56px;padding:24px;border-radius:16px;background:#faf9f7;border:1px solid var(--card);color:var(--muted);font-size:13px;line-height:1.7}
  .method b{color:var(--ink)}

  /* viewport tabs */
  .vp-tabs{display:flex;gap:8px;margin:22px 0 4px}
  .vp-tab{border:1px solid var(--border);background:#fff;border-radius:999px;padding:7px 16px;
    font-size:13px;font-weight:600;cursor:pointer;color:var(--muted)}
  .vp-tab.active{background:var(--ink);color:#fff;border-color:var(--ink)}

  /* info button + modal */
  .info-btn{width:30px;height:30px;border-radius:50%;border:1px solid rgba(40,37,36,0.18);background:#fff;
    cursor:pointer;font-weight:700;color:var(--ink);font-size:14px;line-height:1}
  .info-btn:hover{background:#faf9f7}
  .modal-back{position:fixed;inset:0;background:rgba(40,37,36,0.45);z-index:100;display:none;
    align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto}
  .modal-back.open{display:flex}
  .modal{background:#fff;border-radius:18px;max-width:680px;width:100%;padding:28px 30px;
    box-shadow:0 20px 60px rgba(40,37,36,0.3);color:var(--ink)}
  .modal h2{font-size:20px;margin-bottom:4px}
  .modal h3{font-size:14px;font-weight:700;margin:18px 0 4px;color:var(--ink)}
  .modal p,.modal li{font-size:13.5px;line-height:1.65;color:var(--muted)}
  .modal ul{margin:6px 0;padding-left:18px}
  .modal code{background:#f4f2ef;padding:1px 6px;border-radius:5px;font-size:12px;color:var(--ink)}
  .modal .mclose{float:right;border:none;background:none;font-size:22px;cursor:pointer;color:var(--faint);line-height:1}

  @media(max-width:720px){
    .hero{grid-template-columns:1fr}
    .step-shots{grid-template-columns:1fr}
  }
</style>
</head>
<body>
  <div class="topbar">
    ${report.favicon ? `<img class="fav" src="${esc(report.favicon)}" alt=""/>` : ""}
    <div class="brand"><b>User Navigation Benchmark</b><small>${esc(domainOf(report.prodUrl))} → ${esc(domainOf(report.candUrl))} · ${esc(stamp)}</small></div>
    <div class="spacer"></div>
    <button class="info-btn" id="infoBtn" type="button" aria-label="Como é medido">i</button>
    <button class="lang-toggle" id="langToggle" type="button"></button>
  </div>

  ${methodologyModal(report, lang)}

  <header class="cover">
    ${report.logo ? `<img class="cover-logo" src="${esc(report.logo)}" alt=""/>` : ""}
    <div class="eyebrow">${L("RELATÓRIO DE PERFORMANCE", "PERFORMANCE REPORT", lang)}</div>
    <h1>${L("A navegação, medida passo a passo — antes e depois.", "The journey, measured step by step — before and after.", lang)}</h1>
    <div class="kicker">${L("Home → listagem → paginação → produto → variante. Cache aquecido e prefetch por hover nos dois sites.", "Home → listing → pagination → product → variant. Warm cache and hover-prefetch on both sites.", lang)}</div>
    <div class="sites">
      <span>${L("Antes", "Before", lang)}: <b>${esc(domainOf(report.prodUrl))}</b> (Fresh)</span>
      <span>·</span>
      <span>${L("Depois", "After", lang)}: <b>${esc(domainOf(report.candUrl))}</b> (TanStack)</span>
    </div>
  </header>

  ${failureBanner(report, lang)}

  ${vpTabs}

  ${viewports}

  <div class="method">
    <b>${L("Metodologia", "Methodology", lang)}.</b>
    ${L(
      `Um explorador ("batedor") valida, nos DOIS sites, uma categoria (PLP) e um produto (PDP) que realmente funcionam (renderizam produto, sem erro) e fixa as MESMAS páginas para ambos. Depois, no cenário do VISITANTE RECORRENTE, cada lado aquece ${report.warmupRuns}× a borda (Cloudflare) E o cache do navegador (então o bundle JS do SPA e os assets já ficam em cache, como quem já visitou antes) e então medimos ${report.measuredRuns}× (mediana) a navegação real: home → menu hambúrguer → PLP → paginação → produto → produto→produto (SPA na shelf) → variante. Cada tempo é medido até um sinal de conteúdo real (a imagem do produto renderizar), não até "networkidle" (os trackers do Fresh nunca ficam ociosos). Web Vitals via Lighthouse.`,
      `A scout validates, on BOTH sites, a category (PLP) and a product (PDP) that actually work (render a product, no error) and pins the SAME pages for both. Then, in the RETURNING-VISITOR scenario, each side warms the edge (Cloudflare) AND the browser cache ${report.warmupRuns}× (so the SPA's JS bundle and assets are already cached, like someone who has visited before) and we measure ${report.measuredRuns}× (median) the real navigation: home → hamburger menu → PLP → pagination → product → product→product (SPA shelf hop) → variant. Each timing is measured to a real content signal (the product image rendering), not to "networkidle" (Fresh's trackers never go idle). Web Vitals via Lighthouse.`,
      lang,
    )}
    <br/><br/>
    <b>${L("Passo SPA (shelf)", "SPA step (shelf)", lang)}:</b>
    ${L(
      "na PDP, com cache quente e prefetch, clicamos num produto da prateleira de recomendados — uma navegação produto→produto que sempre existe. É o teste de SPA mais confiável: no TanStack é navegação SPA (instantânea), no Fresh é recarregar a página inteira.",
      "on the PDP, with a warm cache and prefetch, we click a product in the recommendation shelf — a product→product navigation that always exists. It's the most reliable SPA test: on TanStack it's an instant SPA navigation, on Fresh it's a full page reload.",
      lang,
    )}
    <br/><br/>
    <b>${L("Troca de variante", "Variant switch", lang)}:</b>
    ${L(
      "só medimos quando o produto tem variante de cor (trocar cor = navegar para outra página/SKU, onde o SPA ganha). Produtos de cor única (só tamanho, que é seleção in-place) aparecem como “não aplicável”.",
      "measured only when the product has a colour variant (switching colour = navigating to another page/SKU, where the SPA wins). Single-colour products (size only, an in-place selection) show as “not applicable”.",
      lang,
    )}
  </div>

<script>
(function(){
  var KEY="unb-lang";
  var toggle=document.getElementById("langToggle");
  function apply(lang){
    document.documentElement.lang=lang;
    document.querySelectorAll(".i18n").forEach(function(e){
      var t=e.dataset[lang];
      if(t!=null) e.textContent=t;
    });
    document.querySelectorAll(".i18n-html").forEach(function(e){
      var t=e.dataset[lang];
      if(t!=null) e.innerHTML=t;
    });
    toggle.textContent = lang==="pt" ? "EN" : "PT";
    try{localStorage.setItem(KEY,lang)}catch(_){}
  }
  var saved;
  try{saved=localStorage.getItem(KEY)}catch(_){}
  apply(saved==="en"||saved==="pt"?saved:document.documentElement.lang||"pt");
  toggle.addEventListener("click",function(){
    apply(document.documentElement.lang==="pt"?"en":"pt");
  });

  // Viewport tabs (mobile/desktop)
  var tabs=document.querySelectorAll(".vp-tab");
  tabs.forEach(function(tab){
    tab.addEventListener("click",function(){
      var vp=tab.dataset.vp;
      tabs.forEach(function(t){t.classList.toggle("active",t.dataset.vp===vp)});
      document.querySelectorAll(".vp-panel").forEach(function(p){p.hidden=p.dataset.vp!==vp});
    });
  });

  // "How it's measured" info modal
  var modal=document.getElementById("infoModal");
  var openBtn=document.getElementById("infoBtn");
  var closeBtn=document.getElementById("infoClose");
  if(openBtn&&modal){
    openBtn.addEventListener("click",function(){modal.classList.add("open")});
    closeBtn.addEventListener("click",function(){modal.classList.remove("open")});
    modal.addEventListener("click",function(e){if(e.target===modal)modal.classList.remove("open")});
    document.addEventListener("keydown",function(e){if(e.key==="Escape")modal.classList.remove("open")});
  }
})();
</script>
</body>
</html>`;
}
