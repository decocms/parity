import { relative } from "node:path";
import type { Issue, Run } from "../types/schema.ts";
import { REPORT_CSS, REPORT_JS } from "./html-template.ts";

function esc(html: string): string {
  return html
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

function renderIssue(issue: Issue, runDir: string): string {
  const evidenceHtml = (issue.evidence ?? [])
    .filter((e) => e.kind === "screenshot")
    .map(
      (e) =>
        `<figure><img src="${escape(relPath(runDir, e.path))}" alt="${escape(e.label ?? "")}" loading="lazy"/><figcaption>${escape(e.label ?? "")}</figcaption></figure>`,
    )
    .join("");

  return `
  <div class="issue sev-${issue.severity}">
    <div class="meta">${escape(issue.severity.toUpperCase())} • ${escape(issue.category)} • ${escape(issue.check)}${issue.page ? ` • <code>${escape(issue.page)}</code>` : ""}</div>
    <h3>${escape(issue.summary)}</h3>
    ${issue.details ? `<div class="label">Details</div><div class="details">${escape(issue.details)}</div>` : ""}
    ${issue.reproduction ? `<div class="label">Reproduction</div><div class="repro">${escape(issue.reproduction)}</div>` : ""}
    ${issue.suggestedFix ? `<div class="label">Suggested fix</div><div class="fix">${escape(issue.suggestedFix)}</div>` : ""}
    ${evidenceHtml ? `<div class="ss-pair">${evidenceHtml}</div>` : ""}
  </div>`;
}

function renderSummary(run: Run): string {
  const statusClass = run.verdict.status;
  return `
  <div class="score-block">
    <div class="score-circle ${statusClass}">
      <div class="score">${run.verdict.score}</div>
      <div class="label">${run.verdict.status.toUpperCase()}</div>
    </div>
    <div>
      <div class="badges">
        <div class="badge-sev"><span class="dot critical"></span> <span class="count">${run.verdict.critical}</span> critical</div>
        <div class="badge-sev"><span class="dot high"></span> <span class="count">${run.verdict.high}</span> high</div>
        <div class="badge-sev"><span class="dot medium"></span> <span class="count">${run.verdict.medium}</span> medium</div>
        <div class="badge-sev"><span class="dot low"></span> <span class="count">${run.verdict.low}</span> low</div>
      </div>
      <p style="margin-top:16px;color:var(--fg-muted);font-size:13px;">
        ${run.verdict.checksRun} checks (${run.verdict.checksPassed} pass · ${run.verdict.checksFailed} fail · ${run.verdict.checksSkipped} skipped) ·
        ${(run.durationMs / 1000).toFixed(1)}s
      </p>
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
    ${run.topIssues.map((i) => renderIssue(i, runDir)).join("")}
  </div>`;
}

function renderChecksTable(run: Run): string {
  return `
  <div class="card">
    <h2>Checks executados</h2>
    <table>
      <thead><tr><th>Check</th><th>Status</th><th>Severidade</th><th>Issues</th><th>Duração</th><th>Resumo</th></tr></thead>
      <tbody>
        ${run.checks
          .map(
            (c) => `
          <tr>
            <td><code>${escape(c.name)}</code></td>
            <td><span class="status-pill status-${c.status}">${c.status}</span></td>
            <td>${escape(c.severity)}</td>
            <td>${c.issues.length}</td>
            <td>${c.durationMs}ms</td>
            <td>${escape(c.summary)}</td>
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

function renderVitalsPanel(run: Run): string {
  const blocks: string[] = [];
  for (const c of run.checks) {
    if (c.name !== "web-vitals-mobile") continue;
    blocks.push(`<div class="card"><h2>${escape(c.summary)}</h2>${c.issues.map((i) => `<div class="details">${escape(i.summary)}\n${escape(i.details ?? "")}</div>`).join("")}</div>`);
  }
  if (blocks.length === 0) {
    return `<div class="empty">Nenhuma medida de Web Vitals registrada para mobile.</div>`;
  }
  return blocks.join("");
}

function renderPagesTable(run: Run): string {
  const seen = new Set<string>();
  type Row = { key: string; viewport: string; status: string };
  const rows: Row[] = [];
  for (const fc of run.flowCaptures) {
    for (const p of fc.pages) {
      const k = `${p.url}::${p.viewport}::${p.side}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ key: `${p.side}:${p.url}`, viewport: p.viewport, status: String(p.status) });
    }
  }
  if (rows.length === 0) {
    return `<div class="empty">Nenhuma página capturada.</div>`;
  }
  return `
  <div class="card">
    <h2>Páginas capturadas</h2>
    <table>
      <thead><tr><th>Página</th><th>Viewport</th><th>Status</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><code>${escape(r.key)}</code></td><td>${r.viewport}</td><td>${r.status}</td></tr>`).join("")}</tbody>
    </table>
  </div>`;
}

function renderConsolePanel(run: Run): string {
  const c = run.checks.find((x) => x.name === "console-errors-baseline");
  if (!c || c.issues.length === 0) {
    return `<div class="empty">Nenhum erro de console novo em cand vs prod.</div>`;
  }
  return c.issues.map((i) => `<div class="issue sev-${i.severity}"><h3>${escape(i.summary)}</h3><div class="details">${escape(i.details ?? "")}</div></div>`).join("");
}

function renderNetworkPanel(run: Run): string {
  const c = run.checks.find((x) => x.name === "network-summary-delta");
  if (!c || c.issues.length === 0) {
    return `<div class="empty">Sem divergência relevante de network.</div>`;
  }
  return c.issues.map((i) => `<div class="issue sev-${i.severity}"><h3>${escape(i.summary)}</h3><div class="details">${escape(i.details ?? "")}</div></div>`).join("");
}

function renderDiffPanel(run: Run): string {
  if (!run.baseline) {
    return `<div class="empty">Run executada sem baseline. Use <code>--baseline &lt;name&gt;</code> para comparação.</div>`;
  }
  const { resolved, new: created, regressions } = run.baseline.delta;
  return `
  <div class="card">
    <h2>Delta vs baseline <code>${escape(run.baseline.name)}</code></h2>
    <p>✅ Resolvidos: ${resolved.length} · 🆕 Novos: ${created.length} · ⚠️ Regressões: ${regressions.length}</p>
    ${created.length ? `<div class="label">Novos</div>${created.map((i) => renderIssue(i, "")).join("")}` : ""}
    ${regressions.length ? `<div class="label">Regressões</div>${regressions.map((i) => renderIssue(i, "")).join("")}` : ""}
  </div>`;
}

export function renderHtmlReport(run: Run, runDir: string): string {
  const issueCount = run.issues.length;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <title>parity — ${escape(run.id)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <header>
    <div>
      <h1>parity report · ${escape(run.id)}</h1>
      <div class="urls">prod: <a href="${escape(run.prodUrl)}">${escape(run.prodUrl)}</a> · cand: <a href="${escape(run.candUrl)}">${escape(run.candUrl)}</a></div>
    </div>
    <div class="urls">flows: ${run.flows.join(", ")} · viewports: ${run.viewports.join(", ")}</div>
  </header>
  <div class="layout">
    <nav class="tabs">
      <div class="tab" data-tab="summary">Resumo</div>
      <div class="tab" data-tab="issues">Issues <span class="badge">${issueCount}</span></div>
      <div class="tab" data-tab="pages">Páginas</div>
      <div class="tab" data-tab="vitals">Vitals</div>
      <div class="tab" data-tab="console">Console</div>
      <div class="tab" data-tab="network">Network</div>
      <div class="tab" data-tab="diff">Diff${run.baseline ? "" : " (s/ baseline)"}</div>
    </nav>
    <section class="panel" data-panel="summary">
      ${renderSummary(run)}
      ${renderTopIssues(run, runDir)}
      ${renderChecksTable(run)}
    </section>
    <section class="panel" data-panel="issues">
      ${renderIssuesPanel(run, runDir)}
    </section>
    <section class="panel" data-panel="pages">
      ${renderPagesTable(run)}
    </section>
    <section class="panel" data-panel="vitals">
      ${renderVitalsPanel(run)}
    </section>
    <section class="panel" data-panel="console">
      ${renderConsolePanel(run)}
    </section>
    <section class="panel" data-panel="network">
      ${renderNetworkPanel(run)}
    </section>
    <section class="panel" data-panel="diff">
      ${renderDiffPanel(run)}
    </section>
  </div>
  <script>${REPORT_JS}</script>
</body>
</html>`;
}
