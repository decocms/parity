import { relative } from "node:path";
import { buildCacheReport, type CacheReport, type ClassifiedRequest } from "../diff/cache.ts";
import type { Issue, NetworkEntry, Run } from "../types/schema.ts";
import { REPORT_CSS, REPORT_JS } from "./html-template.ts";
import { buildLlmPrompt } from "./prompt-builder.ts";

function esc(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function relPath(runDir: string, absPath: string | undefined): string {
  if (!absPath) return "";
  try {
    return relative(runDir, absPath);
  } catch {
    return absPath;
  }
}

/**
 * Turn a pair-key like `/::mobile` or `/vale-presente::desktop` into something
 * a human reads: "Home · mobile" / "/vale-presente · desktop".
 */
function humanKey(key: string): string {
  const parts = key.split("::");
  const path = parts[0] ?? key;
  const viewport = parts[1] ?? "";
  const niceName = path === "/" || path === "" ? "Home" : path;
  return viewport ? `${niceName} · ${viewport}` : niceName;
}

function renderIssue(issue: Issue, runDir: string): string {
  const evidenceHtml = (issue.evidence ?? [])
    .filter((e) => e.kind === "screenshot")
    .map(
      (e) =>
        `<figure><img src="${esc(relPath(runDir, e.path))}" alt="${esc(e.label ?? "")}" loading="lazy"/><figcaption>${esc(e.label ?? "")}</figcaption></figure>`,
    )
    .join("");

  const pageLabel = issue.page ? humanKey(issue.page) : "";

  const details = issue.details ?? "";
  const detailsIsList = /\n\s*-\s|^\s*-\s/.test(details) || details.split("\n").length > 4;

  return `
  <div class="issue sev-${issue.severity}">
    <div class="issue-tags">
      <span class="tag sev-${issue.severity}">${esc(issue.severity)}</span>
      <span class="tag">${esc(issue.category)}</span>
      <span class="tag tag-mono">${esc(issue.check)}</span>
      ${pageLabel ? `<span class="tag tag-page">${esc(pageLabel)}</span>` : ""}
    </div>
    <h3>${esc(issue.summary)}</h3>
    ${
      issue.details
        ? `<details class="issue-section" ${detailsIsList ? "" : "open"}>
        <summary><span class="section-label">Detalhes</span><button class="copy-btn" data-copy-target="issue-d-${esc(issue.id)}">copiar</button></summary>
        <pre class="details" id="issue-d-${esc(issue.id)}">${esc(issue.details)}</pre>
      </details>`
        : ""
    }
    ${
      issue.reproduction
        ? `<details class="issue-section">
        <summary><span class="section-label">Reprodução</span><button class="copy-btn" data-copy-target="issue-r-${esc(issue.id)}">copiar</button></summary>
        <pre class="repro" id="issue-r-${esc(issue.id)}">${esc(issue.reproduction)}</pre>
      </details>`
        : ""
    }
    ${
      issue.suggestedFix
        ? `<details class="issue-section" open>
        <summary><span class="section-label">Fix sugerido</span><button class="copy-btn" data-copy-target="issue-f-${esc(issue.id)}">copiar</button></summary>
        <pre class="fix" id="issue-f-${esc(issue.id)}">${esc(issue.suggestedFix)}</pre>
      </details>`
        : ""
    }
    ${evidenceHtml ? `<details class="issue-section"><summary><span class="section-label">Screenshots (${(issue.evidence ?? []).length})</span></summary><div class="ss-pair">${evidenceHtml}</div></details>` : ""}
  </div>`;
}

function renderVerdict(run: Run): string {
  const v = run.verdict;
  const statusLabel = v.status === "pass" ? "✓ PASS" : v.status === "warn" ? "⚠ WARN" : "✗ FAIL";
  return `
  <div class="verdict-bar">
    <div class="verdict-status ${v.status}">${statusLabel}</div>
    <div class="verdict-score">
      <div class="num">${v.score}<span style="font-size:14px;color:var(--fg-muted);font-weight:400">/100</span></div>
      <div class="lbl">parity score</div>
    </div>
    <div class="verdict-sep"></div>
    <div class="verdict-counts">
      <div class="count-pill"><span class="dot critical"></span><span class="num">${v.critical}</span> critical</div>
      <div class="count-pill"><span class="dot high"></span><span class="num">${v.high}</span> high</div>
      <div class="count-pill"><span class="dot medium"></span><span class="num">${v.medium}</span> medium</div>
      <div class="count-pill"><span class="dot low"></span><span class="num">${v.low}</span> low</div>
    </div>
    <div class="verdict-checks">
      <span class="green">${v.checksPassed}</span> pass · <span class="red">${v.checksFailed}</span> fail · ${v.checksSkipped} skipped &nbsp;·&nbsp; ${(run.durationMs / 1000).toFixed(1)}s
    </div>
  </div>`;
}

function renderTopIssues(run: Run, runDir: string): string {
  if (run.topIssues.length === 0) {
    return `<div class="card"><div class="empty">Nenhuma issue prioritária 🎉</div></div>`;
  }
  return `
  <div class="card">
    <h2>Top issues</h2>
    <div class="hint">Issues priorizadas e agregadas; veja a aba Issues para a lista completa.</div>
    ${run.topIssues.map((i) => renderIssue(i, runDir)).join("")}
  </div>`;
}

function renderChecksTable(run: Run): string {
  return `
  <div class="card">
    <h2>Checks executados</h2>
    <table>
      <thead><tr><th>Check</th><th>Status</th><th class="num">Issues</th><th class="num">Duração</th><th>Resumo</th></tr></thead>
      <tbody>
        ${run.checks
          .map(
            (c) => `
          <tr>
            <td><code>${esc(c.name)}</code></td>
            <td><span class="status-pill status-${c.status}">${c.status}</span></td>
            <td class="num">${c.issues.length}</td>
            <td class="num">${c.durationMs}ms</td>
            <td>${esc(c.summary)}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  </div>`;
}

function renderIssuesPanel(run: Run, runDir: string): string {
  if (run.issues.length === 0) {
    return `<div class="empty">Nenhuma issue registrada.</div>`;
  }
  return run.issues.map((i) => renderIssue(i, runDir)).join("");
}

interface VitalsRow {
  page: string;
  viewport: string;
  metric: "LCP" | "FCP" | "TTFB" | "INP" | "CLS";
  prod: number | null;
  cand: number | null;
}

function renderVitalsPanel(run: Run): string {
  // Build a table from flowCaptures (which carry per-page vitals)
  const rows: VitalsRow[] = [];
  for (const fc of run.flowCaptures) {
    if (fc.viewport !== "mobile") continue;
    for (const p of fc.pages) {
      const v = p.vitals;
      const pageKey = humanKey(`${pathOf(p.url)}::${p.viewport}`);
      const sideLabel = p.side;
      // Find matching pair on the other side
      // For simplicity, push a row per (page, metric, side), then group in render
      void sideLabel;
      rows.push({ page: pageKey, viewport: p.viewport, metric: "LCP", prod: 0, cand: 0 });
      rows.push({ page: pageKey, viewport: p.viewport, metric: "FCP", prod: 0, cand: 0 });
      rows.push({ page: pageKey, viewport: p.viewport, metric: "TTFB", prod: 0, cand: 0 });
      rows.push({ page: pageKey, viewport: p.viewport, metric: "INP", prod: 0, cand: 0 });
      rows.push({ page: pageKey, viewport: p.viewport, metric: "CLS", prod: 0, cand: 0 });
      // Will be filled in proper aggregation below; simpler approach: build by page key
    }
  }

  // Aggregation: pair pages by (path, viewport) and side
  const byPage = new Map<string, { prod: number | null; cand: number | null }[]>();
  type Vitals = NonNullable<typeof run.flowCaptures[number]["pages"][number]["vitals"]>;
  const pageVitals = new Map<string, { prod?: Vitals; cand?: Vitals; viewport: string }>();
  for (const fc of run.flowCaptures) {
    if (fc.viewport !== "mobile") continue;
    for (const p of fc.pages) {
      const key = pathOf(p.url);
      const entry = pageVitals.get(key) ?? { viewport: p.viewport };
      if (p.side === "prod") entry.prod = p.vitals;
      else entry.cand = p.vitals;
      pageVitals.set(key, entry);
    }
  }
  void byPage; // unused placeholder

  if (pageVitals.size === 0) {
    return `<div class="empty">Nenhuma medida de Web Vitals registrada para mobile.</div>`;
  }

  const metricRow = (
    name: string,
    prod: number | null | undefined,
    cand: number | null | undefined,
    unit: "ms" | "score",
    higherIsBad: boolean,
  ) => {
    const p = prod ?? null;
    const c = cand ?? null;
    let deltaCell = `<td class="num delta-neutral">—</td>`;
    if (p != null && c != null) {
      const delta = c - p;
      const pct = p !== 0 ? (delta / p) * 100 : 0;
      const isBad = higherIsBad ? delta > 0 : delta < 0;
      const cls = Math.abs(delta) < 0.001 ? "delta-neutral" : isBad ? "delta-bad" : "delta-good";
      const sign = delta > 0 ? "+" : "";
      const display = unit === "ms" ? `${sign}${delta.toFixed(0)}ms (${sign}${pct.toFixed(0)}%)` : `${sign}${delta.toFixed(3)}`;
      deltaCell = `<td class="num ${cls}">${esc(display)}</td>`;
    }
    return `
      <tr>
        <td class="metric-name">${esc(name)}</td>
        <td class="num">${formatVital(p, unit)}</td>
        <td class="num">${formatVital(c, unit)}</td>
        ${deltaCell}
      </tr>`;
  };

  const cards = [...pageVitals.entries()].map(([path, entry]) => {
    const title = humanKey(`${path}::${entry.viewport}`);
    return `
    <div class="card">
      <h2>${esc(title)}</h2>
      <table class="vitals-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th class="num">prod</th>
            <th class="num">cand</th>
            <th class="num">Δ</th>
          </tr>
        </thead>
        <tbody>
          ${metricRow("LCP (Largest Contentful Paint)", entry.prod?.lcp, entry.cand?.lcp, "ms", true)}
          ${metricRow("FCP (First Contentful Paint)", entry.prod?.fcp, entry.cand?.fcp, "ms", true)}
          ${metricRow("TTFB (Time to First Byte)", entry.prod?.ttfb, entry.cand?.ttfb, "ms", true)}
          ${metricRow("INP (Interaction to Next Paint)", entry.prod?.inp, entry.cand?.inp, "ms", true)}
          ${metricRow("CLS (Cumulative Layout Shift)", entry.prod?.cls, entry.cand?.cls, "score", true)}
        </tbody>
      </table>
      <div class="hint">prod = Fresh (verdade) · cand = TanStack · Δ verde = cand melhor que prod · Δ vermelho = regressão</div>
    </div>`;
  });
  return cards.join("");
}

function formatVital(v: number | null, unit: "ms" | "score"): string {
  if (v == null) return "—";
  if (unit === "score") return v.toFixed(3);
  return `${v.toFixed(0)}ms`;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

function renderPagesTable(run: Run): string {
  type Row = { key: string; viewport: string; side: string; status: string; url: string };
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const fc of run.flowCaptures) {
    for (const p of fc.pages) {
      const k = `${p.url}::${p.viewport}::${p.side}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({
        key: humanKey(`${pathOf(p.url)}::${p.viewport}`),
        viewport: p.viewport,
        side: p.side,
        status: String(p.status),
        url: p.url,
      });
    }
  }
  if (rows.length === 0) return `<div class="empty">Nenhuma página capturada.</div>`;
  return `
  <div class="card">
    <h2>Páginas capturadas</h2>
    <table>
      <thead><tr><th>Página</th><th>Side</th><th>Viewport</th><th class="num">Status</th><th>URL</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.key)}</td><td>${esc(r.side)}</td><td>${esc(r.viewport)}</td><td class="num">${esc(r.status)}</td><td><code>${esc(r.url)}</code></td></tr>`).join("")}</tbody>
    </table>
  </div>`;
}

function renderConsolePanel(run: Run, runDir: string): string {
  const c = run.checks.find((x) => x.name === "console-errors-baseline");
  if (!c || c.issues.length === 0) {
    return `<div class="empty">Nenhum erro de console novo em cand vs prod.</div>`;
  }
  return c.issues.map((i) => renderIssue(i, runDir)).join("");
}

function renderNetworkPanel(run: Run): string {
  // Aggregate cand requests across all captures
  const candEntries: NetworkEntry[] = [];
  let baseUrl = "";
  for (const fc of run.flowCaptures) {
    for (const p of fc.pages) {
      if (p.side !== "cand") continue;
      if (!baseUrl) baseUrl = p.url;
      candEntries.push(...p.network);
    }
  }
  if (candEntries.length === 0) {
    return `<div class="empty">Nenhum request de network capturado.</div>`;
  }
  const report = buildCacheReport(candEntries, baseUrl);
  return renderNetworkTable(report);
}

function renderNetworkTable(report: CacheReport): string {
  // Build a single table with all requests, sortable + filterable client-side
  const rows = report.all.map((r, idx) => {
    const url = r.entry.url;
    const sizeKb = r.entry.bytes != null ? (r.entry.bytes / 1024).toFixed(1) : "—";
    const cacheCls = r.decision === "hit" ? "cache-hit" : r.decision === "miss" || r.decision === "unknown" ? "cache-miss" : "cache-bypass";
    const cacheLabel = r.decision === "unknown" ? "miss?" : r.decision;
    return `<tr data-cat="${r.category}" data-decision="${r.decision}" data-status="${r.entry.status}" data-bytes="${r.entry.bytes ?? 0}" data-url="${esc(url.toLowerCase())}" data-idx="${idx}">
      <td class="url-cell"><a href="${esc(url)}" target="_blank" rel="noreferrer" title="${esc(url)}">${esc(humanizeNetworkUrl(url))}</a></td>
      <td><span class="net-cat cat-${r.category}">${esc(r.category)}</span></td>
      <td class="num">${r.entry.status}</td>
      <td class="num">${sizeKb} KB</td>
      <td><span class="net-cache ${cacheCls}">${cacheLabel}</span></td>
    </tr>`;
  });
  return `
  <div class="card">
    <h2>Network · ${report.total} requests · ${(report.totalBytes / 1024).toFixed(0)} KB</h2>
    <div class="hint">Hits, misses e categorias de cada request capturado em cand. Click no cabeçalho pra ordenar.</div>
    <div class="net-toolbar">
      <input id="net-search" type="search" placeholder="filtrar por URL…" class="net-input"/>
      <select id="net-filter-cat" class="net-input">
        <option value="">todas categorias</option>
        <option value="document">document</option>
        <option value="static-asset">static-asset</option>
        <option value="image">image</option>
        <option value="font">font</option>
        <option value="api">api</option>
        <option value="third-party">third-party</option>
        <option value="other">other</option>
      </select>
      <select id="net-filter-cache" class="net-input">
        <option value="">qualquer cache</option>
        <option value="hit">só HIT</option>
        <option value="miss">só MISS/unknown</option>
        <option value="bypass">só BYPASS</option>
      </select>
      <span class="net-count" id="net-count">${rows.length} / ${rows.length} rows</span>
    </div>
    <table class="net-table sortable" id="net-table">
      <thead>
        <tr>
          <th data-sort="url">URL</th>
          <th data-sort="cat">Tipo</th>
          <th data-sort="status" class="num">Status</th>
          <th data-sort="bytes" class="num">Bytes</th>
          <th data-sort="cache">Cache</th>
        </tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  </div>`;
}

function humanizeNetworkUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + (u.search ? `${u.search.slice(0, 40)}${u.search.length > 40 ? "…" : ""}` : "");
    return `${u.hostname}${path}`;
  } catch {
    return url.slice(0, 120);
  }
}

function renderCachePanel(run: Run): string {
  const candEntries: NetworkEntry[] = [];
  let baseUrl = "";
  let prodHitRate: number | null = null;
  for (const fc of run.flowCaptures) {
    for (const p of fc.pages) {
      if (p.side === "cand") {
        candEntries.push(...p.network);
        if (!baseUrl) baseUrl = p.url;
      }
    }
  }
  if (candEntries.length === 0) {
    return `<div class="empty">Sem dados de network em cand.</div>`;
  }
  const report = buildCacheReport(candEntries, baseUrl);
  // Prod hit rate (informational only)
  {
    const prodEntries: NetworkEntry[] = [];
    let prodBase = "";
    for (const fc of run.flowCaptures) {
      for (const p of fc.pages) {
        if (p.side === "prod") {
          prodEntries.push(...p.network);
          if (!prodBase) prodBase = p.url;
        }
      }
    }
    if (prodEntries.length > 0) {
      prodHitRate = buildCacheReport(prodEntries, prodBase).hitRate;
    }
  }

  const oppBytes = report.opportunities.reduce((s, r) => s + (r.entry.bytes ?? 0), 0);
  const hitPct = (report.hitRate * 100).toFixed(0);
  const deltaText = prodHitRate != null
    ? prodHitRate > report.hitRate
      ? `<span class="delta-bad">↓ ${((prodHitRate - report.hitRate) * 100).toFixed(0)}pp vs prod</span>`
      : `<span class="delta-good">↑ ${((report.hitRate - prodHitRate) * 100).toFixed(0)}pp vs prod</span>`
    : `<span class="dim">sem comparação prod</span>`;

  return `
  <div class="card cache-hero">
    <div class="hero-grid">
      <div class="hero-stat">
        <div class="big-num">${hitPct}%</div>
        <div class="big-label">cache hit rate (cand)</div>
        <div class="hero-meta">${deltaText}</div>
      </div>
      <div class="hero-stat">
        <div class="big-num">${report.opportunities.length}</div>
        <div class="big-label">oportunidades</div>
        <div class="hero-meta">${(oppBytes / 1024).toFixed(0)} KB cacheável que vai MISS</div>
      </div>
      <div class="hero-stat">
        <div class="big-num">${report.total}</div>
        <div class="big-label">requests analisados</div>
        <div class="hero-meta">${(report.totalBytes / 1024).toFixed(0)} KB total</div>
      </div>
    </div>
    <div class="hint">Foco em cand — prod (Fresh) é só referência. Oportunidade = static-asset/image/font com hash na URL que está MISS em cand.</div>
  </div>

  ${renderCategoryBreakdown(report)}

  <details class="card" open>
    <summary><h2 style="display:inline">❌ Oportunidades — ${report.opportunities.length} requests cacheable em MISS</h2></summary>
    <div class="hint">Adicionar rule de cache pra essas URLs deve reduzir ${(oppBytes / 1024).toFixed(0)} KB / ${report.opportunities.length} requests.</div>
    ${renderRequestList(report.opportunities, true)}
  </details>

  <details class="card">
    <summary><h2 style="display:inline">✅ Cacheando bem — ${report.byDecision.hit} HITs</h2></summary>
    ${renderRequestList(report.all.filter((r) => r.decision === "hit").sort((a, b) => (b.entry.bytes ?? 0) - (a.entry.bytes ?? 0)).slice(0, 50), false)}
  </details>

  <details class="card">
    <summary><h2 style="display:inline">⊘ Ignorados — third-party e dynamic</h2></summary>
    <div class="hint">Requests que não devem ou não podem cachear (ads, analytics, APIs com dados dinâmicos).</div>
    ${renderRequestList(report.all.filter((r) => r.category === "third-party" || r.category === "api").slice(0, 50), false)}
  </details>`;
}

function renderCategoryBreakdown(report: CacheReport): string {
  const rows = (Object.entries(report.byCategory) as Array<[string, { count: number; bytes: number; hitRate: number }]>)
    .filter(([, info]) => info.count > 0)
    .sort(([, a], [, b]) => b.bytes - a.bytes)
    .map(([cat, info]) => {
      const hr = (info.hitRate * 100).toFixed(0);
      const hrClass = info.hitRate > 0.8 ? "delta-good" : info.hitRate > 0.4 ? "delta-neutral" : "delta-bad";
      return `<tr>
        <td><span class="net-cat cat-${cat}">${cat}</span></td>
        <td class="num">${info.count}</td>
        <td class="num">${(info.bytes / 1024).toFixed(0)} KB</td>
        <td class="num ${hrClass}">${hr}%</td>
      </tr>`;
    })
    .join("");
  return `
  <div class="card">
    <h2>Por categoria</h2>
    <table class="cat-table">
      <thead><tr><th>Categoria</th><th class="num">Requests</th><th class="num">Bytes</th><th class="num">Hit rate</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderRequestList(reqs: ClassifiedRequest[], highlightOpportunity: boolean): string {
  if (reqs.length === 0) {
    return `<div class="empty">Nenhum request nesta categoria.</div>`;
  }
  const rows = reqs.map((r) => {
    const sizeKb = r.entry.bytes != null ? (r.entry.bytes / 1024).toFixed(1) : "—";
    const url = r.entry.url;
    return `<tr ${highlightOpportunity ? 'class="opp-row"' : ""}>
      <td class="num">${sizeKb} KB</td>
      <td><span class="net-cat cat-${r.category}">${r.category}</span></td>
      <td><span class="net-cache ${r.decision === "hit" ? "cache-hit" : "cache-miss"}">${r.decision === "unknown" ? "miss?" : r.decision}</span></td>
      <td class="url-cell"><a href="${esc(url)}" target="_blank" rel="noreferrer" title="${esc(url)}">${esc(humanizeNetworkUrl(url))}</a></td>
    </tr>`;
  });
  return `<table class="net-table">
    <thead><tr><th class="num">Size</th><th>Tipo</th><th>Cache</th><th>URL</th></tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>`;
}

function renderDiffPanel(run: Run, runDir: string): string {
  if (!run.baseline) {
    return `<div class="empty">Run executada sem baseline. Use <code>--baseline &lt;name&gt;</code> para comparação.</div>`;
  }
  const { resolved, new: created, regressions } = run.baseline.delta;
  return `
  <div class="card">
    <h2>Delta vs baseline <code>${esc(run.baseline.name)}</code></h2>
    <p>✅ Resolvidos: ${resolved.length} · 🆕 Novos: ${created.length} · ⚠️ Regressões: ${regressions.length}</p>
    ${created.length ? `<div class="label">Novos</div>${created.map((i) => renderIssue(i, runDir)).join("")}` : ""}
    ${regressions.length ? `<div class="label">Regressões</div>${regressions.map((i) => renderIssue(i, runDir)).join("")}` : ""}
  </div>`;
}

function renderPromptPanel(run: Run): string {
  const md = buildLlmPrompt(run, { limit: 20 });
  const charCount = md.length;
  return `
  <div class="card">
    <h2>Prompt para LLM</h2>
    <div class="hint">Pronto pra colar em Claude / ChatGPT / qualquer chat. Lista issues ranqueadas + contexto da migração + instruções específicas pra diagnose e fix.</div>
    <div class="prompt-toolbar">
      <button id="prompt-copy">📋 Copiar markdown</button>
      <button class="secondary" id="prompt-download">⬇ Download .md</button>
      <span class="feedback" id="prompt-feedback"></span>
      <div class="right">${charCount.toLocaleString("en-US")} chars · ${(charCount / 1024).toFixed(1)} KB</div>
    </div>
    <div class="prompt-md" id="prompt-md">${esc(md)}</div>
  </div>`;
}

interface SbsPair {
  label: string;
  prodUrl: string;
  candUrl: string;
}

function buildSideBySidePairs(run: Run): SbsPair[] {
  const pairs: SbsPair[] = [];
  // Always include home
  pairs.push({ label: "Home", prodUrl: run.prodUrl, candUrl: run.candUrl });

  // Extract PLP + PDP from mobile flow captures
  const findPaths = (side: "prod" | "cand"): { plp?: string; pdp?: string } => {
    const out: { plp?: string; pdp?: string } = {};
    for (const fc of run.flowCaptures) {
      if (fc.side !== side || fc.viewport !== "mobile") continue;
      if (fc.flow !== "purchase-journey" && fc.flow !== "pdp" && fc.flow !== "plp") continue;
      for (const p of fc.pages) {
        const path = pathOf(p.url);
        if (path === "/" || path === "") continue;
        if (!out.plp) out.plp = path;
        else if (path !== out.plp) out.pdp = path;
      }
    }
    return out;
  };

  const prodPaths = findPaths("prod");
  const candPaths = findPaths("cand");

  if (prodPaths.plp) {
    const candPlp = candPaths.plp ?? prodPaths.plp;
    pairs.push({
      label: "PLP",
      prodUrl: new URL(prodPaths.plp, run.prodUrl).toString(),
      candUrl: new URL(candPlp, run.candUrl).toString(),
    });
  }
  if (prodPaths.pdp) {
    const candPdp = candPaths.pdp ?? prodPaths.pdp;
    pairs.push({
      label: "PDP",
      prodUrl: new URL(prodPaths.pdp, run.prodUrl).toString(),
      candUrl: new URL(candPdp, run.candUrl).toString(),
    });
  }

  return pairs;
}

function renderSideBySidePanel(run: Run): string {
  const pairs = buildSideBySidePairs(run);
  if (pairs.length === 0) {
    return `<div class="empty">Nenhuma URL capturada para visualização lado-a-lado.</div>`;
  }
  return `
  <div class="card">
    <h2>Side-by-side mobile</h2>
    <div class="hint">Compare prod (Fresh, esquerda) com cand (TanStack, direita) em viewport mobile. Scroll sync funciona em iframes same-origin ou quando o site implementa <code>postMessage</code> handler.</div>
    <div class="sbs-toolbar">
      ${pairs.map((p, i) => `<button data-sbs-btn="${i}">${esc(p.label)}</button>`).join("")}
      <label class="label"><input type="checkbox" id="sbs-sync" checked/> Scroll sincronizado</label>
      <div class="toolbar-right">se o site bloquear iframe (X-Frame-Options/CSP), aparecerá frame vazio</div>
    </div>
    <div class="sbs-container">
      <div class="sbs-frame">
        <div class="frame-title">prod (Fresh)</div>
        <div class="frame-url" id="sbs-url-prod">${esc(pairs[0]!.prodUrl)}</div>
        <iframe id="sbs-prod" class="sbs-iframe" src="" sandbox="allow-same-origin allow-scripts allow-forms allow-popups" loading="lazy"></iframe>
      </div>
      <div class="sbs-frame">
        <div class="frame-title">cand (TanStack)</div>
        <div class="frame-url" id="sbs-url-cand">${esc(pairs[0]!.candUrl)}</div>
        <iframe id="sbs-cand" class="sbs-iframe" src="" sandbox="allow-same-origin allow-scripts allow-forms allow-popups" loading="lazy"></iframe>
      </div>
    </div>
    <script>window.__parity_sbs = ${JSON.stringify({ pairs })};</script>
  </div>`;
}

export function renderHtmlReport(run: Run, runDir: string): string {
  const issueCount = run.issues.length;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <title>parity — ${esc(run.id)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <header>
    <div>
      <h1>parity report · <code>${esc(run.id)}</code></h1>
      <div class="urls">prod (Fresh): <a href="${esc(run.prodUrl)}" target="_blank" rel="noreferrer">${esc(run.prodUrl)}</a> · cand (TanStack): <a href="${esc(run.candUrl)}" target="_blank" rel="noreferrer">${esc(run.candUrl)}</a></div>
    </div>
    <div class="meta-right">flows: ${esc(run.flows.join(", "))} · viewports: ${esc(run.viewports.join(", "))} · CEP: ${esc(run.cep)}</div>
  </header>
  <div class="layout">
    <nav class="tabs">
      <div class="tab" data-tab="summary">Resumo</div>
      <div class="tab" data-tab="sidebyside">Side-by-side</div>
      <div class="tab" data-tab="issues">Issues <span class="badge">${issueCount}</span></div>
      <div class="tab" data-tab="vitals">Vitals</div>
      <div class="tab" data-tab="cache">Cache</div>
      <div class="tab" data-tab="checks">Checks <span class="badge">${run.checks.length}</span></div>
      <div class="tab" data-tab="prompt">Prompt LLM</div>
      <div class="tab" data-tab="pages">Páginas</div>
      <div class="tab" data-tab="console">Console</div>
      <div class="tab" data-tab="network">Network</div>
      <div class="tab" data-tab="diff">Diff${run.baseline ? "" : " (s/ baseline)"}</div>
    </nav>
    <section class="panel" data-panel="summary">
      ${renderVerdict(run)}
      ${renderTopIssues(run, runDir)}
    </section>
    <section class="panel" data-panel="sidebyside">
      ${renderSideBySidePanel(run)}
    </section>
    <section class="panel" data-panel="issues">
      ${renderIssuesPanel(run, runDir)}
    </section>
    <section class="panel" data-panel="vitals">
      ${renderVitalsPanel(run)}
    </section>
    <section class="panel" data-panel="cache">
      ${renderCachePanel(run)}
    </section>
    <section class="panel" data-panel="checks">
      ${renderChecksTable(run)}
    </section>
    <section class="panel" data-panel="prompt">
      ${renderPromptPanel(run)}
    </section>
    <section class="panel" data-panel="pages">
      ${renderPagesTable(run)}
    </section>
    <section class="panel" data-panel="console">
      ${renderConsolePanel(run, runDir)}
    </section>
    <section class="panel" data-panel="network">
      ${renderNetworkPanel(run)}
    </section>
    <section class="panel" data-panel="diff">
      ${renderDiffPanel(run, runDir)}
    </section>
  </div>
  <script>${REPORT_JS}</script>
</body>
</html>`;
}
