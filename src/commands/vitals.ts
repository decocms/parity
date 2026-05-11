import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Browser, BrowserContext, Page } from "playwright";
import { resolveSitemapUrls } from "../diff/sitemap.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { capturePage, installVitalsCollector } from "../engine/collect.ts";
import { createRunDir, newRunId, writeRunReportHtml } from "../storage/fs.ts";
import type { PageCapture, Side, Viewport, WebVitals } from "../types/schema.ts";

export interface VitalsOptions {
  prod: string;
  cand: string;
  /** Comma-separated paths OR a file://path / file path to a list (1 per line). */
  urls?: string;
  /** Cap on auto-discovered pages from sitemap. */
  limit?: number;
  viewports: string;
  concurrency?: number;
  output: string;
  open?: boolean;
}

interface PageResult {
  path: string;
  prodUrl: string;
  candUrl: string;
  viewport: Viewport;
  prod?: PageCapture;
  cand?: PageCapture;
  errorProd?: string;
  errorCand?: string;
}

interface ScoredPage extends PageResult {
  /** > 0 = cand pior (regressão); < 0 = cand melhor */
  regressionScore: number;
  /** True when both sides have any valid vitals to compare */
  hasData: boolean;
}

export async function vitalsCommand(opts: VitalsOptions): Promise<number> {
  const viewports = opts.viewports
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Viewport => s === "mobile" || s === "desktop");
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));

  const runId = newRunId();
  const paths = createRunDir(opts.output, runId);

  console.log(chalk.bold(`\n  parity vitals ${runId}`));
  console.log(chalk.dim(`  prod: ${opts.prod}`));
  console.log(chalk.dim(`  cand: ${opts.cand}`));

  const discoverSpinner = ora("Descobrindo páginas…").start();
  const pagePaths = await discoverPagePaths(opts.prod, opts);
  if (pagePaths.length === 0) {
    discoverSpinner.fail("Nenhuma página descoberta");
    return 2;
  }
  discoverSpinner.succeed(`${pagePaths.length} página(s) · viewports: ${viewports.join(",")} · concorrência: ${concurrency}`);

  const tasks: PageResult[] = [];
  for (const viewport of viewports) {
    for (const path of pagePaths) {
      tasks.push({
        path,
        prodUrl: new URL(path, opts.prod).toString(),
        candUrl: new URL(path, opts.cand).toString(),
        viewport,
      });
    }
  }

  let completed = 0;
  const total = tasks.length;
  const t0 = Date.now();
  const progress = ora(`0/${total} páginas`).start();

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser({ headless: true });

    await runWithConcurrency(tasks, concurrency, async (task) => {
      try {
        const [prod, cand] = await Promise.all([
          captureVitals(browser!, task.viewport, "prod", task.prodUrl, paths.screenshotsDir),
          captureVitals(browser!, task.viewport, "cand", task.candUrl, paths.screenshotsDir),
        ]);
        task.prod = prod;
        task.cand = cand;
      } catch (err) {
        task.errorProd = task.errorProd ?? (err as Error).message;
      } finally {
        completed++;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        const etaSec = completed > 0 ? Math.round(((Date.now() - t0) / completed) * (total - completed) / 1000) : 0;
        progress.text = `${completed}/${total} páginas · ${elapsed}s decorridos · ETA ${etaSec}s · última: ${task.path} (${task.viewport})`;
      }
    });
    progress.succeed(`${total} página(s) coletada(s) em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const scored = scorePages(tasks);
    const html = buildVitalsHtml(opts, scored);
    writeRunReportHtml(paths.runDir, html);
    writeFileSync(
      join(paths.runDir, "vitals.json"),
      `${JSON.stringify(buildJson(opts, scored), null, 2)}\n`,
      "utf8",
    );

    console.log("");
    printSummary(scored);
    console.log("");
    console.log(chalk.dim(`  → ${paths.reportHtml}`));
    console.log("");

    if (opts.open) {
      const { default: open } = await import("open");
      await open(paths.reportHtml).catch(() => undefined);
    }
    return 0;
  } catch (err) {
    progress.fail(`Erro: ${(err as Error).message}`);
    console.error(err);
    return 2;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

async function captureVitals(
  browser: Browser,
  viewport: Viewport,
  side: Side,
  url: string,
  screenshotsDir: string,
): Promise<PageCapture> {
  const ctx = await newContext(browser, { viewport, cohortCookieValue: "control" });
  await installVitalsCollector(ctx);
  const page: Page = await ctx.newPage();
  try {
    const safeName = url.replace(/^https?:\/\//, "").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80);
    const cap = await capturePage(page, {
      url,
      side,
      viewport,
      screenshotPath: `${screenshotsDir}/${safeName}-${viewport}-${side}.png`,
      settleMs: 1500,
      timeoutMs: 25_000,
    });
    return cap;
  } finally {
    await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
  }
}

async function discoverPagePaths(prodUrl: string, opts: VitalsOptions): Promise<string[]> {
  if (opts.urls) {
    return parseUrlList(opts.urls);
  }
  const limit = opts.limit ?? 20;
  const all = await resolveSitemapUrls(prodUrl);
  if (all.length === 0) return ["/"]; // sitemap missing or empty
  const seen = new Set<string>();
  const out: string[] = ["/"]; // always include home
  seen.add("/");
  // Prefer diversity: bucket by first path segment, round-robin
  const buckets = new Map<string, string[]>();
  for (const u of all) {
    let pathOnly = "/";
    try {
      pathOnly = new URL(u).pathname || "/";
    } catch {
      continue;
    }
    if (seen.has(pathOnly)) continue;
    const seg = pathOnly.split("/").filter(Boolean)[0] ?? "_root";
    const arr = buckets.get(seg) ?? [];
    arr.push(pathOnly);
    buckets.set(seg, arr);
  }
  // Round-robin extract until limit reached
  const keys = [...buckets.keys()];
  let idx = 0;
  while (out.length < limit && keys.some((k) => (buckets.get(k)?.length ?? 0) > 0)) {
    const k = keys[idx % keys.length]!;
    const list = buckets.get(k)!;
    const next = list.shift();
    if (next && !seen.has(next)) {
      out.push(next);
      seen.add(next);
    }
    idx++;
  }
  return out.slice(0, limit);
}

function parseUrlList(input: string): string[] {
  if (input.startsWith("file:") || input.endsWith(".txt") || input.endsWith(".list")) {
    const path = input.replace(/^file:\/\//, "");
    if (existsSync(path)) {
      return readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"))
        .map((s) => (s.startsWith("/") ? s : `/${s}`));
    }
  }
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("/") || s.startsWith("http") ? s : `/${s}`));
}

async function runWithConcurrency<T>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= items.length) break;
        await fn(items[idx]!);
      }
    }),
  );
}

function scorePages(tasks: PageResult[]): ScoredPage[] {
  const out: ScoredPage[] = tasks.map((t) => {
    const score = computeRegressionScore(t.prod?.vitals, t.cand?.vitals);
    const hasData = !!t.prod?.vitals && !!t.cand?.vitals && hasAnyMetric(t.prod.vitals) && hasAnyMetric(t.cand.vitals);
    return { ...t, regressionScore: score, hasData };
  });
  // Sort: worst regressions first (highest score), then by absolute |score| within ties
  return out.sort((a, b) => b.regressionScore - a.regressionScore);
}

function computeRegressionScore(prod: WebVitals | undefined, cand: WebVitals | undefined): number {
  if (!prod || !cand) return 0;
  let score = 0;
  // Sum normalized regressions across timing metrics (LCP/FCP/TTFB/INP) — positive = regression
  const timing: Array<keyof WebVitals> = ["lcp", "fcp", "ttfb", "inp"];
  for (const key of timing) {
    const p = prod[key];
    const c = cand[key];
    if (p != null && c != null && p > 0) {
      score += (c - p) / p;
    }
  }
  // CLS: absolute delta, weighted (CLS 0.1 is huge)
  if (prod.cls != null && cand.cls != null) {
    score += (cand.cls - prod.cls) * 4;
  }
  return score;
}

function hasAnyMetric(v: WebVitals): boolean {
  return v.lcp != null || v.fcp != null || v.ttfb != null || v.inp != null || v.cls != null;
}

function printSummary(pages: ScoredPage[]): void {
  const withData = pages.filter((p) => p.hasData);
  const regressing = withData.filter((p) => p.regressionScore > 0.1);
  const improving = withData.filter((p) => p.regressionScore < -0.1);
  const stable = withData.length - regressing.length - improving.length;
  console.log(chalk.bold("  Summary:"));
  console.log(`    ${chalk.red("⚠")} ${regressing.length} página(s) com regressão`);
  console.log(`    ${chalk.green("↓")} ${improving.length} página(s) melhoraram`);
  console.log(`    ${chalk.dim("~")} ${stable} estável(s)`);
  if (regressing.length > 0) {
    console.log("");
    console.log(chalk.bold("  Top 3 piores:"));
    for (const p of regressing.slice(0, 3)) {
      console.log(
        `    ${chalk.red(`${(p.regressionScore * 100).toFixed(0)}%`)} ${chalk.dim(`[${p.viewport}]`)} ${p.path}`,
      );
    }
  }
  if (improving.length > 0) {
    console.log("");
    console.log(chalk.bold("  Top 3 melhores:"));
    for (const p of improving.slice(-3).reverse()) {
      console.log(
        `    ${chalk.green(`${(p.regressionScore * 100).toFixed(0)}%`)} ${chalk.dim(`[${p.viewport}]`)} ${p.path}`,
      );
    }
  }
}

function buildJson(opts: VitalsOptions, pages: ScoredPage[]): Record<string, unknown> {
  return {
    schemaVersion: "0.1",
    prod: opts.prod,
    cand: opts.cand,
    pages: pages.map((p) => ({
      path: p.path,
      viewport: p.viewport,
      regressionScore: p.regressionScore,
      prod: p.prod?.vitals,
      cand: p.cand?.vitals,
      prodStatus: p.prod?.status,
      candStatus: p.cand?.status,
    })),
  };
}

/* ---------- HTML rendering ---------- */

function esc(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMs(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v.toFixed(0)}ms`;
}
function fmtCls(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toFixed(3);
}

function renderDeltaMs(p: number | null | undefined, c: number | null | undefined): string {
  if (p == null || c == null) return `<td class="num delta-neutral">—</td>`;
  const delta = c - p;
  const pct = p > 0 ? (delta / p) * 100 : 0;
  const isBad = delta > 0;
  const cls = Math.abs(delta) < 1 ? "delta-neutral" : isBad ? "delta-bad" : "delta-good";
  const sign = delta > 0 ? "+" : "";
  return `<td class="num ${cls}">${sign}${delta.toFixed(0)}ms (${sign}${pct.toFixed(0)}%)</td>`;
}
function renderDeltaAbs(p: number | null | undefined, c: number | null | undefined): string {
  if (p == null || c == null) return `<td class="num delta-neutral">—</td>`;
  const delta = c - p;
  const isBad = delta > 0;
  const cls = Math.abs(delta) < 0.001 ? "delta-neutral" : isBad ? "delta-bad" : "delta-good";
  const sign = delta > 0 ? "+" : "";
  return `<td class="num ${cls}">${sign}${delta.toFixed(3)}</td>`;
}

function metricRow(
  label: string,
  prod: number | null | undefined,
  cand: number | null | undefined,
  kind: "ms" | "cls",
): string {
  const fmt = kind === "ms" ? fmtMs : fmtCls;
  const delta = kind === "ms" ? renderDeltaMs(prod, cand) : renderDeltaAbs(prod, cand);
  return `<tr>
    <td class="metric-name">${esc(label)}</td>
    <td class="num">${esc(fmt(prod))}</td>
    <td class="num">${esc(fmt(cand))}</td>
    ${delta}
  </tr>`;
}

function classifyPage(score: number): "regression" | "improvement" | "stable" {
  if (score > 0.1) return "regression";
  if (score < -0.1) return "improvement";
  return "stable";
}

function renderPageCard(p: ScoredPage, openByDefault: boolean): string {
  const title = `${p.path === "/" ? "Home" : p.path} · ${p.viewport}`;
  const cls = classifyPage(p.regressionScore);
  const scoreText =
    p.hasData
      ? cls === "regression"
        ? `<span class="badge bad">+${(p.regressionScore * 100).toFixed(0)}% regressão</span>`
        : cls === "improvement"
          ? `<span class="badge good">${(p.regressionScore * 100).toFixed(0)}% melhoria</span>`
          : `<span class="badge neutral">estável</span>`
      : `<span class="badge missing">sem dados</span>`;
  const body = p.hasData
    ? `<table class="vitals-table">
        <thead><tr><th>Metric</th><th class="num">prod</th><th class="num">cand</th><th class="num">Δ</th></tr></thead>
        <tbody>
          ${metricRow("LCP (Largest Contentful Paint)", p.prod?.vitals.lcp, p.cand?.vitals.lcp, "ms")}
          ${metricRow("FCP (First Contentful Paint)", p.prod?.vitals.fcp, p.cand?.vitals.fcp, "ms")}
          ${metricRow("TTFB (Time to First Byte)", p.prod?.vitals.ttfb, p.cand?.vitals.ttfb, "ms")}
          ${metricRow("INP (Interaction to Next Paint)", p.prod?.vitals.inp, p.cand?.vitals.inp, "ms")}
          ${metricRow("CLS (Cumulative Layout Shift)", p.prod?.vitals.cls, p.cand?.vitals.cls, "cls")}
        </tbody>
      </table>
      <div class="hint">prod = Fresh · cand = TanStack · Δ verde = cand melhor · Δ vermelho = regressão</div>`
    : `<div class="hint">Sem medidas (prod status: ${p.prod?.status ?? "—"} · cand status: ${p.cand?.status ?? "—"})</div>`;
  return `<details class="card card-${cls}" ${openByDefault ? "open" : ""}>
    <summary>
      <span class="card-title">${esc(title)}</span>
      ${scoreText}
    </summary>
    ${body}
  </details>`;
}

function buildVitalsHtml(opts: VitalsOptions, pages: ScoredPage[]): string {
  const withData = pages.filter((p) => p.hasData);
  const sortedRegressing = withData.filter((p) => p.regressionScore > 0.1).sort((a, b) => b.regressionScore - a.regressionScore);
  const sortedImproving = withData.filter((p) => p.regressionScore < -0.1).sort((a, b) => a.regressionScore - b.regressionScore);
  const stable = withData.filter((p) => Math.abs(p.regressionScore) <= 0.1);
  const noData = pages.filter((p) => !p.hasData);

  const topWorst = sortedRegressing.slice(0, 3);
  const topBest = sortedImproving.slice(0, 3);
  const restRegressing = sortedRegressing.slice(3);
  const restImproving = sortedImproving.slice(3);

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"/>
<title>parity vitals · ${esc(opts.prod)}</title>
<style>
:root{--bg:#0b0e14;--card:#131720;--elev:#1a1f2b;--border:#232a37;--fg:#e6e8eb;--muted:#8a93a6;--green:#2ec27e;--yellow:#f5a623;--red:#e5484d;--accent:#4f7df3}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:var(--bg);color:var(--fg);padding:24px;line-height:1.5;max-width:1200px;margin-left:auto;margin-right:auto}
h1{font-size:20px;margin:0 0 6px 0}
.urls{color:var(--muted);font-size:13px;margin-bottom:24px}
h2{font-size:13px;color:var(--muted);margin:32px 0 10px 0;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;display:flex;align-items:center;gap:8px}
h2 .count{background:var(--elev);padding:2px 8px;border-radius:10px;font-size:11px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin-bottom:12px;overflow:hidden}
.card[open]{padding-bottom:20px}
.card.card-regression{border-left:3px solid var(--red)}
.card.card-improvement{border-left:3px solid var(--green)}
.card.card-stable{border-left:3px solid var(--border)}
summary{display:flex;align-items:center;justify-content:space-between;cursor:pointer;list-style:none;font-size:15px;font-weight:600;padding:4px 0;gap:12px}
summary::-webkit-details-marker{display:none}
summary::before{content:"▶";display:inline-block;color:var(--muted);transition:transform .15s;font-size:10px;margin-right:8px}
.card[open] summary::before{transform:rotate(90deg)}
.card-title{flex:1;font-size:15px}
.badge{font-size:11px;font-weight:700;padding:4px 10px;border-radius:6px;text-transform:uppercase;letter-spacing:0.04em}
.badge.bad{background:rgba(229,72,77,0.15);color:var(--red)}
.badge.good{background:rgba(46,194,126,0.15);color:var(--green)}
.badge.neutral{background:rgba(138,147,166,0.15);color:var(--muted)}
.badge.missing{background:rgba(245,166,35,0.15);color:var(--yellow)}
table.vitals-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:14px}
.vitals-table th,.vitals-table td{padding:8px 12px;border-bottom:1px solid var(--border);text-align:left}
.vitals-table th{color:var(--muted);font-weight:500}
.vitals-table .num{text-align:right;font-variant-numeric:tabular-nums}
.vitals-table .metric-name{font-weight:600}
.delta-bad{color:var(--red);font-weight:600}
.delta-good{color:var(--green);font-weight:600}
.delta-neutral{color:var(--muted)}
.hint{font-size:11px;color:var(--muted);margin-top:8px}
</style></head><body>
<h1>parity vitals</h1>
<div class="urls"><strong>prod</strong> ${esc(opts.prod)} · <strong>cand</strong> ${esc(opts.cand)}<br/>
${withData.length} página(s) com dados · ${sortedRegressing.length} regressões · ${sortedImproving.length} melhorias · ${stable.length} estáveis${noData.length > 0 ? ` · ${noData.length} sem dados` : ""}</div>

${topWorst.length > 0 ? `<h2>🔴 Top piores <span class="count">${topWorst.length}</span></h2>
${topWorst.map((p) => renderPageCard(p, true)).join("")}` : ""}

${topBest.length > 0 ? `<h2>🟢 Top melhores <span class="count">${topBest.length}</span></h2>
${topBest.map((p) => renderPageCard(p, true)).join("")}` : ""}

${restRegressing.length > 0 ? `<h2>Outras regressões <span class="count">${restRegressing.length}</span></h2>
${restRegressing.map((p) => renderPageCard(p, false)).join("")}` : ""}

${restImproving.length > 0 ? `<h2>Outras melhorias <span class="count">${restImproving.length}</span></h2>
${restImproving.map((p) => renderPageCard(p, false)).join("")}` : ""}

${stable.length > 0 ? `<h2>Estáveis <span class="count">${stable.length}</span></h2>
${stable.map((p) => renderPageCard(p, false)).join("")}` : ""}

${noData.length > 0 ? `<h2>Sem dados <span class="count">${noData.length}</span></h2>
${noData.map((p) => renderPageCard(p, false)).join("")}` : ""}

</body></html>`;
}

// Need access to BrowserContext type to fix unused-var lint
void (null as unknown as BrowserContext);
