import { buildCacheReport, type CacheReport, type ClassifiedRequest } from "../diff/cache.ts";
import type { Issue, NetworkEntry, Run, SeoPageMeta, VisualDiffPage } from "../types/schema.ts";
import { REPORT_CSS, REPORT_JS } from "./html-template.ts";
import {
  escapeHtml as esc,
  humanKey,
  relPath,
  renderIssueHtml,
} from "./issue-html.ts";
import { buildLlmPrompt } from "./prompt-builder.ts";
import { buildVisualPrompt } from "./visual-prompt-builder.ts";

/**
 * Local alias preserved so the rest of this file keeps the original
 * `renderIssue(issue, runDir)` call-site signature unchanged. The actual
 * implementation now lives in `src/report/issue-html.ts:renderIssueHtml`
 * — shared with the audit report.
 */
function renderIssue(issue: Issue, runDir: string): string {
  return renderIssueHtml(issue, { runDir });
}

function renderDashboard(run: Run): string {
  const v = run.verdict;
  const statusLabel = v.status === "pass" ? "Excelente" : v.status === "warn" ? "Bom, com ressalvas" : "Crítico";
  const ringColor = v.status === "pass" ? "var(--state-good)" : v.status === "warn" ? "var(--state-warn)" : "var(--state-bad)";
  const ringDeg = `${Math.round((v.score / 100) * 360)}deg`;

  // Build metric tiles from check results
  const tiles = buildTiles(run);

  return `
  <div class="dash-hero">
    <div class="health-score" style="--ring-color:${ringColor};--ring-deg:${ringDeg}">
      <div class="score-num">${v.score}<small>/100</small></div>
      <div class="score-label">Health</div>
    </div>
    <div class="dash-hero-info">
      <div class="verdict-text ${v.status}">${statusLabel}</div>
      <div class="verdict-sub">${v.critical + v.high} issue${v.critical + v.high !== 1 ? "s" : ""} bloqueante${v.critical + v.high !== 1 ? "s" : ""} ${v.critical > 0 ? `(${v.critical} crítica${v.critical !== 1 ? "s" : ""})` : ""}</div>
      <div class="verdict-meta">
        <span><strong>${v.checksPassed}</strong> checks pass</span>
        <span><strong>${v.checksFailed}</strong> fail</span>
        <span><strong>${v.checksSkipped}</strong> skipped</span>
        <span><strong>${(run.durationMs / 1000).toFixed(1)}s</strong> total</span>
      </div>
    </div>
  </div>

  <div class="tiles">
    ${tiles.map((t) => renderTile(t)).join("")}
  </div>

  ${renderTopIssues(run, "")}`;
}

interface Tile {
  icon: string;
  label: string;
  value: string;
  meta: string;
  state: "pass" | "warn" | "fail" | "info";
  href?: string;
}

function buildTiles(run: Run): Tile[] {
  const tiles: Tile[] = [];

  // Purchase journey
  const pj = run.checks.find((c) => c.name === "purchase-journey-flow");
  if (pj) {
    const data = (pj.data ?? {}) as { totalSteps?: number; failedSteps?: number };
    const total = data.totalSteps ?? 0;
    const failed = data.failedSteps ?? 0;
    tiles.push({
      icon: "🛒",
      label: "Jornada",
      value: total > 0 ? `${total - failed}/${total}` : "—",
      meta: failed > 0 ? `${failed} step(s) falhou` : "completou em ambos",
      state: failed > 0 ? "fail" : "pass",
      href: "#issues",
    });
  }

  // Cache
  const cache = run.checks.find((c) => c.name === "cache-coverage");
  if (cache) {
    const data = (cache.data ?? {}) as { hitRate?: number; opportunityCount?: number };
    tiles.push({
      icon: "💾",
      label: "Cache",
      value: `${((data.hitRate ?? 0) * 100).toFixed(0)}%`,
      meta: `${data.opportunityCount ?? 0} oportunidades`,
      state: (data.hitRate ?? 0) > 0.7 ? "pass" : (data.hitRate ?? 0) > 0.4 ? "warn" : "fail",
      href: "#cache",
    });
  }

  // Vitals
  const vitals = run.checks.find((c) => c.name === "web-vitals-mobile");
  if (vitals) {
    tiles.push({
      icon: "📊",
      label: "Vitals",
      value: vitals.status === "pass" ? "✓" : vitals.issues.length.toString(),
      meta: vitals.status === "pass" ? "sem regressões" : `${vitals.issues.length} regressão(ões)`,
      state: vitals.status === "pass" ? "pass" : "fail",
      href: "#vitals",
    });
  }

  // SEO
  const seo = run.checks.find((c) => c.name === "seo-deep-audit");
  if (seo) {
    const critical = seo.issues.filter((i) => i.severity === "critical").length;
    tiles.push({
      icon: "🔍",
      label: "SEO",
      value: critical > 0 ? `${critical} crit` : seo.status === "pass" ? "✓" : seo.issues.length.toString(),
      meta: critical > 0 ? "noindex / robots regression" : `${seo.issues.length} issue(s)`,
      state: critical > 0 ? "fail" : seo.status === "pass" ? "pass" : "warn",
      href: "#seo",
    });
  }

  // Console
  const console_ = run.checks.find((c) => c.name === "console-errors-baseline");
  if (console_) {
    tiles.push({
      icon: "🔧",
      label: "Console",
      value: console_.issues.length.toString(),
      meta: console_.status === "pass" ? "sem erros novos" : "errors em cand",
      state: console_.status === "pass" ? "pass" : "fail",
      href: "#console",
    });
  }

  // Visual
  const visual = run.checks.find((c) => c.name === "visual-regression-keyframes");
  if (visual) {
    const vd = run.visualDiff;
    const value = vd ? `${vd.pagesWithDiffs}/${vd.pagesChecked}` : visual.issues.length.toString();
    const meta = vd
      ? vd.pagesWithDiffs === 0
        ? "todas as páginas OK"
        : `${vd.pagesWithDiffs} página(s) com diff`
      : visual.status === "pass"
        ? "sem regressão visual"
        : "diferenças detectadas";
    tiles.push({
      icon: "🖼",
      label: "Visual",
      value,
      meta,
      state: visual.status === "pass" ? "pass" : "warn",
      href: "#visualdiff",
    });
  }

  return tiles;
}

function renderTile(t: Tile): string {
  const inner = `
    <div class="tile-icon">${t.icon}</div>
    <div class="tile-label">${esc(t.label)}</div>
    <div class="tile-value">${esc(t.value)}</div>
    <div class="tile-meta">${esc(t.meta)}</div>`;
  if (t.href) {
    return `<a class="tile state-${t.state}" href="${esc(t.href)}" onclick="window.dispatchEvent(new HashChangeEvent('hashchange'))">${inner}</a>`;
  }
  return `<div class="tile state-${t.state}">${inner}</div>`;
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

function renderVisualDiffPanel(run: Run, runDir: string): string {
  const vd = run.visualDiff;
  if (!vd || vd.results.length === 0) {
    return `
    <div class="card">
      <h2>Visual Diff</h2>
      <div class="empty">Nenhuma comparação visual rodou. Use <code>--visual-pages &lt;n&gt;</code> (default 5) e configure <code>ANTHROPIC_API_KEY</code> para a análise semântica via LLM Vision.</div>
    </div>`;
  }

  const sortedResults = [...vd.results].sort((a, b) => {
    const order = { failed: 0, diffs: 1, pass: 2 } as const;
    return order[a.verdict] - order[b.verdict];
  });

  const cards = sortedResults
    .map((page, idx) => renderVisualDiffPage(page, runDir, idx === 0))
    .join("");

  const md = buildVisualPrompt(run, runDir);
  const charCount = md.length;

  return `
  <div class="card">
    <h2>Visual Diff <span class="hint-inline">prod (Fresh) vs cand (TanStack)</span></h2>
    <div class="vd-summary">
      <span class="vd-badge total">${vd.pagesChecked} páginas</span>
      <span class="vd-badge warn">${vd.pagesWithDiffs} com diff</span>
      <span class="vd-badge good">${vd.pagesPassed} OK</span>
      ${vd.pagesFailed > 0 ? `<span class="vd-badge bad">${vd.pagesFailed} falha de análise</span>` : ""}
      <span class="vd-badge info">${vd.llmCallsUsed} chamadas LLM Vision</span>
    </div>
    <div class="vd-filters">
      <label class="label"><input type="checkbox" class="vd-filter" data-vd-show="diffs" checked/> com diffs</label>
      <label class="label"><input type="checkbox" class="vd-filter" data-vd-show="pass"/> OK</label>
      <label class="label"><input type="checkbox" class="vd-filter" data-vd-show="failed" checked/> falha</label>
      <select id="vd-viewport-filter">
        <option value="">todos os viewports</option>
        <option value="mobile">mobile</option>
        <option value="desktop">desktop</option>
        <option value="tablet">tablet</option>
      </select>
    </div>
    <div class="vd-list">
      ${cards}
    </div>
  </div>

  <div class="card">
    <h2>Prompt para LLM (visual)</h2>
    <div class="hint">Pronto pra colar em Claude / ChatGPT — lista as páginas com diffs, sections faltantes, screenshots referenciados, e instruções específicas pra corrigir migração Fresh → TanStack.</div>
    <div class="prompt-toolbar">
      <button id="vprompt-copy">📋 Copiar markdown</button>
      <button class="secondary" id="vprompt-download">⬇ Download .md</button>
      <span class="feedback" id="vprompt-feedback"></span>
      <div class="right">${charCount.toLocaleString("en-US")} chars · ${(charCount / 1024).toFixed(1)} KB</div>
    </div>
    <div class="prompt-md" id="vprompt-md">${esc(md)}</div>
  </div>`;
}

function renderFig(srcPath: string, alt: string, variantClass: string, label: string): string {
  const safeSrc = esc(srcPath);
  return `
        <figure class="vd-fig ${variantClass}">
          <figcaption>${esc(label)}</figcaption>
          <div class="vd-img-wrap">
            <img src="${safeSrc}" alt="${esc(alt)}" loading="lazy" class="vd-img" onerror="this.classList.add('broken'); var fb = this.nextElementSibling; if (fb) fb.classList.add('show');"/>
            <div class="vd-img-fallback">
              <span class="icon">🖼️</span>
              <span class="msg">imagem não encontrada</span>
              <span class="path">${safeSrc}</span>
            </div>
          </div>
        </figure>`;
}

/**
 * Best-effort extraction of the scheme+host from a captured URL so we can
 * build a `--prod`/`--cand` flag that points back at the same site. Returns
 * the original input when parsing fails (URL malformed mid-run, etc.).
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Build the "drill into this one page" shell command. We pick
 * `parity check visual-regression-keyframes` because it re-runs the same
 * check the user is looking at, against the same prod/cand pair, on just
 * this page+viewport — fastest way to see fresh full output (~10s).
 */
function buildVisualDeepDiveCommand(page: VisualDiffPage): string {
  const prodOrigin = originOf(page.prodUrl);
  const candOrigin = originOf(page.candUrl);
  const pagePath = page.pagePath || "/";
  return `parity check visual-regression-keyframes --prod ${prodOrigin} --cand ${candOrigin} --page '${pagePath}' --viewports ${page.viewport}`;
}

/**
 * Build the deepest-dive shell command (HTML + screenshot + computed-styles +
 * heatmap + CSS source + LLM 1-paragraph summary). Useful when the user wants
 * to actually FIX a specific divergence — we default the selector to `body`
 * so it works without the user needing to pick one upfront. They can rerun
 * with a tighter selector when they spot the bad region.
 */
function buildVisualFixCommand(page: VisualDiffPage): string {
  const prodUrl = page.prodUrl;
  const candUrl = page.candUrl;
  return `parity fix --prod ${prodUrl} --cand ${candUrl} --selector body --viewport ${page.viewport}`;
}

function renderVisualDiffPage(page: VisualDiffPage, runDir: string, openFirst: boolean): string {
  const verdictClass = page.verdict === "pass" ? "ok" : page.verdict === "failed" ? "bad" : "warn";
  const verdictLabel = page.verdict === "pass" ? "OK" : page.verdict === "failed" ? "FAIL" : "DIFFS";
  const diffsCount = page.differences.length;
  const sectionsMissing = page.sectionsOnlyInProd.length;
  const maxSev = page.differences.reduce<string>((best, d) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    if (order[d.severity] < (order[best as keyof typeof order] ?? 99)) return d.severity;
    return best;
  }, "");

  const headerBadges: string[] = [];
  headerBadges.push(`<span class="vd-badge ${verdictClass}">${verdictLabel}</span>`);
  if (diffsCount > 0) headerBadges.push(`<span class="vd-badge info">${diffsCount} diff(s)</span>`);
  if (sectionsMissing > 0) headerBadges.push(`<span class="vd-badge bad">${sectionsMissing} section(s) ausente(s)</span>`);
  if (maxSev) headerBadges.push(`<span class="vd-badge sev-${maxSev}">${maxSev}</span>`);
  headerBadges.push(`<span class="vd-badge dim">${(page.pctDiff * 100).toFixed(2)}% pixels</span>`);
  if (page.cachedAt) headerBadges.push(`<span class="vd-badge dim" title="reused from cross-run cache">cached</span>`);

  const heatmapHtml = page.heatmapPath
    ? renderFig(relPath(runDir, page.heatmapPath), "heatmap", "vd-fig-heatmap", "HEATMAP (pixelmatch)")
    : `<figure class="vd-fig vd-fig-heatmap vd-fig-empty"><figcaption>HEATMAP</figcaption><div class="vd-empty-cell"><span class="icon">🗺️</span><span>heatmap não gerado</span></div></figure>`;

  const diffsList = page.differences
    .map(
      (d) => `
    <li class="vd-diff sev-${d.severity}">
      <span class="vd-diff-tags">
        <span class="tag sev-${d.severity}">${esc(d.severity)}</span>
        <span class="tag">${esc(d.region)}</span>
        <span class="tag tag-mono">${esc(d.type)}</span>
      </span>
      <span class="vd-diff-desc">${esc(d.description)}</span>
    </li>`,
    )
    .join("");

  const sectionsHtml = page.sectionsOnlyInProd.length > 0
    ? `<div class="vd-sections">
        <div class="vd-sections-title">Sections detectadas no DOM de prod e AUSENTES em cand:</div>
        <ul class="vd-sections-list">
          ${page.sectionsOnlyInProd.map((s) => `<li><code>${esc(s)}</code></li>`).join("")}
        </ul>
      </div>`
    : "";

  const errorHtml = page.llmError
    ? `<div class="vd-error">⚠️ LLM Vision retornou erro: ${esc(page.llmError)}</div>`
    : "";

  // For pages with diffs, surface the exact CLI commands to drill in. This
  // shortens the "I see something off — how do I get more detail?" loop from
  // "remember the command name" to "click copy, paste, run".
  const showDeepDive = page.verdict !== "pass";
  const deepDiveId = `vd-cmd-${page.pageKey.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const fixId = `vd-fix-${page.pageKey.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const pctLabel = `${(page.pctDiff * 100).toFixed(2)}%`;
  const cmdCheck = buildVisualDeepDiveCommand(page);
  const cmdFix = buildVisualFixCommand(page);
  const deepDiveHtml = showDeepDive
    ? `<div class="vd-deepdive">
        <div class="vd-deepdive-title">Esta página tem <strong>${pctLabel}</strong> de diferença. Pra detalhes completos:</div>
        <div class="vd-deepdive-cmd">
          <div class="vd-deepdive-label">Re-rodar o visual-diff só nessa página (rápido, ~10s):</div>
          <div class="vd-deepdive-row">
            <code class="vd-deepdive-code" id="${deepDiveId}">${esc(cmdCheck)}</code>
            <button class="copy-btn" data-copy-target="${deepDiveId}" type="button">copiar</button>
          </div>
        </div>
        <div class="vd-deepdive-cmd">
          <div class="vd-deepdive-label">Investigar fundo (HTML + screenshot + computed-styles + heatmap + LLM summary):</div>
          <div class="vd-deepdive-row">
            <code class="vd-deepdive-code" id="${fixId}">${esc(cmdFix)}</code>
            <button class="copy-btn" data-copy-target="${fixId}" type="button">copiar</button>
          </div>
        </div>
      </div>`
    : "";

  return `
  <details class="vd-page" data-vd-verdict="${esc(page.verdict)}" data-vd-viewport="${esc(page.viewport)}" ${openFirst ? "open" : ""}>
    <summary class="vd-page-header">
      <span class="vd-page-title">${esc(page.pageLabel)}</span>
      <span class="vd-page-badges">${headerBadges.join(" ")}</span>
    </summary>
    <div class="vd-page-body">
      <div class="vd-gallery">
        ${renderFig(relPath(runDir, page.prodScreenshotPath), "prod", "vd-fig-prod", "PROD (Fresh — fonte da verdade)")}
        ${renderFig(relPath(runDir, page.candScreenshotPath), "cand", "vd-fig-cand", "CAND (TanStack)")}
        ${heatmapHtml}
      </div>
      ${sectionsHtml}
      ${diffsList ? `<div class="vd-diffs-block"><div class="vd-diffs-title">Diferenças visuais (LLM Vision):</div><ul class="vd-diffs-list">${diffsList}</ul></div>` : ""}
      ${errorHtml}
      ${page.differences.length === 0 && page.sectionsOnlyInProd.length === 0 && !page.llmError
        ? `<div class="vd-empty-msg">Nenhuma diferença relevante detectada nesta página. ✅</div>`
        : ""
      }
      ${deepDiveHtml}
      <div class="vd-meta">
        <a href="${esc(page.prodUrl)}" target="_blank" rel="noreferrer">prod ↗</a>
        <a href="${esc(page.candUrl)}" target="_blank" rel="noreferrer">cand ↗</a>
        <span class="dim">viewport: ${esc(page.viewport)} · llm: ${page.llmCalled ? "called" : page.cachedAt ? "cached" : "skipped"}</span>
      </div>
    </div>
  </details>`;
}

function renderSeoPanel(run: Run, runDir: string): string {
  const seo = run.seo;
  if (!seo) {
    return `
    <div class="card">
      <h2>SEO</h2>
      <div class="empty">SEO audit não rodou neste run.</div>
    </div>`;
  }

  const robotsCard = renderSeoRobotsCard(seo.robotsTxt);
  const sitemapCard = renderSeoSitemapCard(seo.sitemap);
  const pagesCard = renderSeoPagesCard(seo.pages);
  const issuesCard = renderSeoIssuesCard(seo.issues, runDir);

  return `
  <div class="card">
    <h2>SEO <span class="hint-inline">robots, sitemap, meta tags, JSON-LD</span></h2>
    <div class="vd-summary">
      <span class="vd-badge total">${seo.pages.length} páginas auditadas</span>
      <span class="vd-badge ${seo.issues.length === 0 ? "good" : "warn"}">${seo.issues.length} issue(s)</span>
      <span class="vd-badge ${seo.pagesWithIssues === 0 ? "good" : "warn"}">${seo.pagesWithIssues} página(s) afetada(s)</span>
    </div>
  </div>
  ${robotsCard}
  ${sitemapCard}
  ${pagesCard}
  ${issuesCard}`;
}

function renderSeoRobotsCard(robots: NonNullable<Run["seo"]>["robotsTxt"]): string {
  const prodBadge = robots.prodPresent
    ? `<span class="vd-badge good">presente</span>`
    : `<span class="vd-badge bad">ausente</span>`;
  const candBadge = robots.candPresent
    ? `<span class="vd-badge good">presente</span>`
    : `<span class="vd-badge bad">ausente</span>`;

  const onlyProdSm = robots.prodSitemaps.filter((s) => !robots.candSitemaps.includes(s));
  const onlyCandSm = robots.candSitemaps.filter((s) => !robots.prodSitemaps.includes(s));

  return `
  <div class="card">
    <h2>robots.txt</h2>
    <table class="seo-kv">
      <tbody>
        <tr><th>prod</th><td>${prodBadge}</td></tr>
        <tr><th>cand</th><td>${candBadge}</td></tr>
        <tr><th>Sitemap(s) declarado(s)</th><td>prod: ${robots.prodSitemaps.length} · cand: ${robots.candSitemaps.length}</td></tr>
        <tr><th>Divergências por User-agent</th><td>${robots.uaDiffCount}</td></tr>
      </tbody>
    </table>
    ${onlyProdSm.length > 0 ? `<div class="seo-sub">Sitemap(s) em prod e ausente(s) em cand: <code>${onlyProdSm.map(esc).join(", ")}</code></div>` : ""}
    ${onlyCandSm.length > 0 ? `<div class="seo-sub">Sitemap(s) só em cand: <code>${onlyCandSm.map(esc).join(", ")}</code></div>` : ""}
    ${
      robots.raw?.prod || robots.raw?.cand
        ? `<details class="seo-raw"><summary>Ver conteúdo bruto (prod vs cand)</summary>
            <div class="seo-raw-pair">
              <div><div class="label">prod</div><pre>${esc(robots.raw?.prod ?? "—")}</pre></div>
              <div><div class="label">cand</div><pre>${esc(robots.raw?.cand ?? "—")}</pre></div>
            </div>
          </details>`
        : ""
    }
  </div>`;
}

function renderSeoSitemapCard(sitemap: NonNullable<Run["seo"]>["sitemap"]): string {
  const deltaClass = sitemap.countPct < -0.05 ? "delta-bad" : sitemap.countPct > 0.05 ? "delta-good" : "delta-neutral";
  const deltaText = `${sitemap.countDelta > 0 ? "+" : ""}${sitemap.countDelta} (${(sitemap.countPct * 100).toFixed(1)}%)`;
  return `
  <div class="card">
    <h2>sitemap.xml</h2>
    <table class="seo-kv">
      <tbody>
        <tr><th>prod</th><td>${sitemap.prodPresent ? `<span class="vd-badge good">presente · ${sitemap.prodCount} URLs</span>` : `<span class="vd-badge bad">ausente</span>`}</td></tr>
        <tr><th>cand</th><td>${sitemap.candPresent ? `<span class="vd-badge good">presente · ${sitemap.candCount} URLs</span>` : `<span class="vd-badge bad">ausente</span>`}</td></tr>
        <tr><th>Δ cand vs prod</th><td class="${deltaClass}">${deltaText}</td></tr>
      </tbody>
    </table>
    ${
      sitemap.onlyProdSample.length > 0
        ? `<div class="seo-sub">URLs em prod e ausentes em cand (amostra ${sitemap.onlyProdSample.length}):
            <ul class="seo-list">${sitemap.onlyProdSample.map((u) => `<li><code>${esc(u)}</code></li>`).join("")}</ul>
          </div>`
        : ""
    }
    ${
      sitemap.onlyCandSample.length > 0
        ? `<div class="seo-sub">URLs só em cand (amostra ${sitemap.onlyCandSample.length}):
            <ul class="seo-list">${sitemap.onlyCandSample.map((u) => `<li><code>${esc(u)}</code></li>`).join("")}</ul>
          </div>`
        : ""
    }
  </div>`;
}

function renderSeoPagesCard(pages: SeoPageMeta[]): string {
  if (pages.length === 0) {
    return `<div class="card"><h2>Meta tags por página</h2><div class="empty">Nenhuma página pareada para auditoria.</div></div>`;
  }
  const rows = pages
    .map((p) => {
      const sevBadge = p.maxSeverity
        ? `<span class="vd-badge sev-${p.maxSeverity}">${p.maxSeverity}</span>`
        : `<span class="vd-badge good">ok</span>`;
      return `
      <details class="seo-page-row ${p.issueCount > 0 ? "has-issues" : ""}" ${p.issueCount > 0 ? "open" : ""}>
        <summary class="seo-page-summary">
          <span class="seo-page-title">${esc(p.pageLabel)}</span>
          <span class="seo-page-badges">
            ${sevBadge}
            ${p.issueCount > 0 ? `<span class="vd-badge warn">${p.issueCount} issue(s)</span>` : ""}
          </span>
        </summary>
        <div class="seo-page-body">
          <table class="seo-meta">
            <thead><tr><th></th><th>prod</th><th>cand</th><th>match</th></tr></thead>
            <tbody>
              ${seoMetaRow("title", p.prodTitle, p.candTitle)}
              ${seoMetaRow("description", p.prodDescription, p.candDescription)}
              ${seoMetaRow("canonical", p.prodCanonical, p.candCanonical)}
              ${seoMetaRow("robots", p.prodRobots, p.candRobots)}
              ${seoMetaRow("X-Robots-Tag", p.prodXRobotsTag, p.candXRobotsTag)}
              ${seoMetaRow("json-ld types", p.prodJsonLdTypes.join(", ") || null, p.candJsonLdTypes.join(", ") || null)}
            </tbody>
          </table>
        </div>
      </details>`;
    })
    .join("");
  return `
  <div class="card">
    <h2>Meta tags por página</h2>
    <div class="hint">Comparação direta de title/description/canonical/robots/json-ld. Linhas em vermelho divergem entre prod e cand.</div>
    ${rows}
  </div>`;
}

function seoMetaRow(label: string, prod: string | null, cand: string | null): string {
  const equal = (prod ?? "") === (cand ?? "");
  const cls = equal ? "match-yes" : "match-no";
  return `
    <tr class="${cls}">
      <th>${esc(label)}</th>
      <td>${prod ? `<code>${esc(prod)}</code>` : `<span class="dim">—</span>`}</td>
      <td>${cand ? `<code>${esc(cand)}</code>` : `<span class="dim">—</span>`}</td>
      <td>${equal ? "✓" : "✗"}</td>
    </tr>`;
}

function renderSeoIssuesCard(issues: Issue[], runDir: string): string {
  if (issues.length === 0) {
    return `<div class="card"><h2>Issues de SEO</h2><div class="empty">Nenhuma issue de SEO detectada 🎉</div></div>`;
  }
  return `
  <div class="card">
    <h2>Issues de SEO (${issues.length})</h2>
    ${issues.map((i) => renderIssue(i, runDir)).join("")}
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
    <div class="hint">Compare prod (Fresh, esquerda) com cand (TanStack, direita) em viewport mobile. Scroll sync funciona quando proxy está ativo OU quando o site implementa <code>postMessage</code> handler.</div>
    <div id="sbs-status" class="sbs-status warn">carregando…</div>
    <div class="sbs-toolbar">
      ${pairs.map((p, i) => `<button data-sbs-btn="${i}">${esc(p.label)}</button>`).join("")}
      <label class="label"><input type="checkbox" id="sbs-sync" checked/> Scroll sincronizado</label>
      <div class="toolbar-right">dica: use <code>parity serve &lt;runId&gt;</code> pra contornar X-Frame-Options</div>
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

interface NavEntry {
  tab: string;
  label: string;
  icon: string;
  count?: number;
}

function buildNav(run: Run): NavEntry[] {
  return [
    { tab: "summary", label: "Dashboard", icon: "🏠" },
    { tab: "visualdiff", label: "Visual Diff", icon: "🖼", count: run.visualDiff?.pagesWithDiffs },
    { tab: "seo", label: "SEO", icon: "🔍", count: run.seo?.issues.length },
    { tab: "sidebyside", label: "Side-by-side", icon: "⇆" },
    { tab: "issues", label: "Issues", icon: "⚠", count: run.issues.length },
    { tab: "vitals", label: "Vitals", icon: "📊" },
    { tab: "cache", label: "Cache", icon: "💾" },
    { tab: "checks", label: "Checks", icon: "✓", count: run.checks.length },
    { tab: "prompt", label: "Prompt LLM", icon: "🤖" },
    { tab: "pages", label: "Páginas", icon: "📄" },
    { tab: "console", label: "Console", icon: "🔧" },
    { tab: "network", label: "Network", icon: "🌐" },
    { tab: "diff", label: "Diff", icon: "📈" },
  ];
}

export function renderHtmlReport(run: Run, runDir: string): string {
  const nav = buildNav(run);
  return `<!DOCTYPE html>
<html lang="pt-BR" data-theme="dark">
<head>
  <meta charset="utf-8"/>
  <title>parity — ${esc(run.id)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <div class="app">
    <aside class="app-sidebar">
      <div class="sidebar-brand">
        <strong>parity</strong>
        <small>${esc(run.id)}</small>
      </div>
      <nav class="sidebar-nav">
        ${nav
          .map(
            (n) => `<div class="nav-item" data-tab="${esc(n.tab)}">
          <span class="icon">${n.icon}</span>
          <span class="label">${esc(n.label)}</span>
          ${n.count != null ? `<span class="count">${n.count}</span>` : ""}
        </div>`,
          )
          .join("")}
      </nav>
      <div class="sidebar-footer">
        flows: ${esc(run.flows.join(", "))}<br/>
        viewports: ${esc(run.viewports.join(", "))}<br/>
        CEP: ${esc(run.cep)}
      </div>
    </aside>
    <header class="app-header">
      <div>
        <h1>Migration parity</h1>
        <div class="urls">
          <span class="url-prod"><a href="${esc(run.prodUrl)}" target="_blank" rel="noreferrer">${esc(run.prodUrl)}</a></span>
          <span class="url-cand"><a href="${esc(run.candUrl)}" target="_blank" rel="noreferrer">${esc(run.candUrl)}</a></span>
        </div>
      </div>
      <div class="header-actions">
        <button class="action-btn" id="theme-toggle">☀ Light</button>
        <button class="action-btn" id="help-btn">? Atalhos</button>
      </div>
    </header>
    <main class="app-main">
      <section class="panel" data-panel="summary">
        ${renderDashboard(run)}
      </section>
      <section class="panel" data-panel="visualdiff">
        ${renderVisualDiffPanel(run, runDir)}
      </section>
      <section class="panel" data-panel="seo">
        ${renderSeoPanel(run, runDir)}
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
    </main>
  </div>
  <div class="help-modal" id="help-modal">
    <div class="modal-inner">
      <h3>Atalhos de teclado</h3>
      <table>
        <tbody>
          <tr><td><kbd>[</kbd> / <kbd>]</kbd></td><td>Navegar entre abas</td></tr>
          <tr><td><kbd>/</kbd></td><td>Foco no campo de busca da aba ativa</td></tr>
          <tr><td><kbd>t</kbd></td><td>Alternar tema dark/light</td></tr>
          <tr><td><kbd>?</kbd></td><td>Mostrar este painel</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Fechar</td></tr>
        </tbody>
      </table>
      <div style="margin-top:16px;text-align:right"><button class="action-btn" id="help-close">Fechar</button></div>
    </div>
  </div>
  <script>${REPORT_JS}</script>
</body>
</html>`;
}
