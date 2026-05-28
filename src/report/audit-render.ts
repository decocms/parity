import type { AuditResult, PageAuditResult } from "../audit/index.ts";
import type { Issue } from "../types/schema.ts";
import { REPORT_CSS, REPORT_JS } from "./html-template.ts";

/**
 * Render a focused single-site audit report. Reuses `REPORT_CSS` /
 * `REPORT_JS` from the comparative report so visual styling stays
 * consistent (severity badges, dashboard cards, copy-buttons), but
 * drops every tab that requires prod×cand pairing (visual diff,
 * side-by-side, sections-only-in-prod, etc).
 *
 * Layout: dashboard at top (totals + category breakdown), then issues
 * grouped first by severity, then by page within each severity.
 */
export function renderAuditHtmlReport(input: {
  result: AuditResult;
  url: string;
  generatedAt: string;
  durationMs: number;
}): string {
  const { result, url, generatedAt, durationMs } = input;
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>parity audit — ${htmlEscape(hostnameOf(url))}</title>
  <style>${REPORT_CSS}</style>
</head>
<body class="audit-report">
  <header class="hero">
    <div class="hero-row">
      <div>
        <h1>parity audit</h1>
        <p class="hero-meta">
          <span>${htmlEscape(url)}</span>
          <span>·</span>
          <span>${result.totals.pages} página(s)</span>
          <span>·</span>
          <span>${Math.round(durationMs / 1000)}s</span>
          <span>·</span>
          <span>${htmlEscape(generatedAt)}</span>
        </p>
      </div>
      <div class="hero-verdict">
        ${renderVerdict(result)}
      </div>
    </div>
  </header>

  <section class="container">
    ${renderDashboard(result)}

    <h2>Issues por severidade</h2>
    ${renderIssuesBySeverity(result.allIssues)}

    <h2>Páginas auditadas</h2>
    ${renderPagesTable(result.pages)}
  </section>

  <script>${REPORT_JS}</script>
</body>
</html>`;
}

function renderVerdict(r: AuditResult): string {
  const blocking = r.totals.critical + r.totals.high;
  if (blocking === 0 && r.totals.issues === 0) {
    return `<div class="verdict pass">✓ PASS</div>`;
  }
  if (r.totals.critical > 0) {
    return `<div class="verdict fail">✖ FAIL · ${r.totals.critical} critical</div>`;
  }
  if (r.totals.high > 0) {
    return `<div class="verdict fail">✖ FAIL · ${r.totals.high} high</div>`;
  }
  return `<div class="verdict warn">⚠ WARN · ${r.totals.medium + r.totals.low} non-blocking</div>`;
}

function renderDashboard(r: AuditResult): string {
  const tiles = [
    { label: "Páginas", value: r.totals.pages, sub: "auditadas" },
    { label: "Critical", value: r.totals.critical, state: r.totals.critical > 0 ? "fail" : "pass" },
    { label: "High", value: r.totals.high, state: r.totals.high > 0 ? "warn" : "pass" },
    { label: "Medium", value: r.totals.medium, state: r.totals.medium > 0 ? "warn" : "pass" },
    { label: "Low", value: r.totals.low, state: "info" },
  ];

  const categoryTotals: Record<Issue["category"], number> = {
    functional: 0,
    visual: 0,
    performance: 0,
    seo: 0,
    console: 0,
    network: 0,
  };
  for (const issue of r.allIssues) categoryTotals[issue.category]++;
  const categoryRows = Object.entries(categoryTotals)
    .filter(([, c]) => c > 0)
    .map(
      ([cat, count]) => `<div class="cat-row">
      <span class="cat-name">${htmlEscape(cat)}</span>
      <span class="cat-count">${count}</span>
    </div>`,
    )
    .join("");

  return `
  <div class="dashboard">
    ${tiles
      .map(
        (t) => `<div class="tile ${t.state ?? ""}">
      <div class="tile-label">${htmlEscape(t.label)}</div>
      <div class="tile-value">${htmlEscape(String(t.value))}</div>
      ${t.sub ? `<div class="tile-sub">${htmlEscape(t.sub)}</div>` : ""}
    </div>`,
      )
      .join("")}
  </div>
  ${
    categoryRows
      ? `<div class="category-breakdown">
    <h3>Por categoria</h3>
    <div class="category-list">${categoryRows}</div>
  </div>`
      : ""
  }`;
}

function renderIssuesBySeverity(issues: Issue[]): string {
  if (issues.length === 0) {
    return `<div class="empty-state">Nenhum issue encontrado 🎉</div>`;
  }
  const groups: Record<Issue["severity"], Issue[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };
  for (const i of issues) groups[i.severity].push(i);

  const sections: string[] = [];
  for (const sev of ["critical", "high", "medium", "low"] as const) {
    const list = groups[sev];
    if (list.length === 0) continue;
    sections.push(`
      <details class="sev-group" ${sev === "critical" || sev === "high" ? "open" : ""}>
        <summary><span class="tag sev-${sev}">${htmlEscape(sev)}</span> ${list.length} issue(s)</summary>
        <div class="issue-list">
          ${list.map(renderIssue).join("")}
        </div>
      </details>
    `);
  }
  return sections.join("");
}

function renderIssue(issue: Issue): string {
  const pageLabel = issue.page ? humanKey(issue.page) : "";
  const details = issue.details ?? "";
  const detailsAutoOpen = details.length < 400;
  return `
  <div class="issue sev-${issue.severity}">
    <div class="issue-tags">
      <span class="tag sev-${issue.severity}">${htmlEscape(issue.severity)}</span>
      <span class="tag">${htmlEscape(issue.category)}</span>
      <span class="tag tag-mono">${htmlEscape(issue.check)}</span>
      ${pageLabel ? `<span class="tag tag-page">${htmlEscape(pageLabel)}</span>` : ""}
    </div>
    <h3>${htmlEscape(issue.summary)}</h3>
    ${
      details
        ? `<details class="issue-section" ${detailsAutoOpen ? "open" : ""}>
        <summary><span class="section-label">Detalhes</span></summary>
        <pre class="details">${htmlEscape(details)}</pre>
      </details>`
        : ""
    }
  </div>`;
}

function renderPagesTable(pages: PageAuditResult[]): string {
  if (pages.length === 0) return "";
  return `
  <table class="pages-table">
    <thead>
      <tr>
        <th>Página</th>
        <th>Viewport</th>
        <th>Status</th>
        <th>Tempo</th>
        <th>Critical</th>
        <th>High</th>
        <th>Medium</th>
        <th>Low</th>
        <th>Total</th>
      </tr>
    </thead>
    <tbody>
      ${pages
        .map(
          (p) => `<tr>
        <td><code>${htmlEscape(pathOf(p.url))}</code></td>
        <td>${htmlEscape(p.viewport)}</td>
        <td class="${p.status >= 400 ? "status-bad" : "status-ok"}">${htmlEscape(String(p.status))}</td>
        <td>${Math.round(p.durationMs / 1000)}s</td>
        <td>${p.bySeverity.critical ?? 0}</td>
        <td>${p.bySeverity.high ?? 0}</td>
        <td>${p.bySeverity.medium ?? 0}</td>
        <td>${p.bySeverity.low ?? 0}</td>
        <td>${p.issues.length}</td>
      </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

// Renamed from `escape` because that's a deprecated global in browser JS
// runtimes and biome flags shadowing it.
function htmlEscape(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function humanKey(key: string): string {
  const parts = key.split("::");
  const path = parts[0] ?? key;
  const viewport = parts[1] ?? "";
  const niceName = path === "/" || path === "" ? "Home" : path;
  return viewport ? `${niceName} · ${viewport}` : niceName;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}
