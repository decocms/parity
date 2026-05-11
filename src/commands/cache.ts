import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Browser, Page } from "playwright";
import { buildCacheReport, type CacheReport } from "../diff/cache.ts";
import { resolveSitemapUrls } from "../diff/sitemap.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { capturePage } from "../engine/collect.ts";
import { createRunDir, newRunId, writeRunReportHtml } from "../storage/fs.ts";
import type { NetworkEntry, Side, Viewport } from "../types/schema.ts";

export interface CacheOptions {
  prod: string;
  cand: string;
  urls?: string;
  /** Pages to crawl (default 30). */
  pages?: number;
  viewports?: string;
  concurrency?: number;
  /** Skip prod entirely (cand-only mode). Default false (still captures prod for comparison). */
  candOnly?: boolean;
  output: string;
  open?: boolean;
}

interface PageNetwork {
  path: string;
  viewport: Viewport;
  side: Side;
  entries: NetworkEntry[];
  durationMs: number;
  error?: string;
}

export async function cacheCommand(opts: CacheOptions): Promise<number> {
  const viewports = (opts.viewports ?? "mobile")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Viewport => s === "mobile" || s === "desktop");
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 8));
  const limit = opts.pages ?? 30;
  const candOnly = opts.candOnly ?? false;

  const runId = newRunId();
  const paths = createRunDir(opts.output, runId);

  console.log(chalk.bold(`\n  parity cache ${runId}`));
  console.log(chalk.dim(`  prod: ${opts.prod}`));
  console.log(chalk.dim(`  cand: ${opts.cand}${candOnly ? " (cand-only)" : ""}`));

  const discoverSpinner = ora("Descobrindo páginas (sitemap)…").start();
  const pagePaths = await discoverPagePaths(opts.prod, opts, limit);
  if (pagePaths.length === 0) {
    discoverSpinner.fail("Nenhuma página descoberta");
    return 2;
  }
  discoverSpinner.succeed(
    `${pagePaths.length} página(s) · viewports: ${viewports.join(",")} · concorrência: ${concurrency}`,
  );

  const sides: Side[] = candOnly ? ["cand"] : ["prod", "cand"];
  const tasks: PageNetwork[] = [];
  for (const viewport of viewports) {
    for (const path of pagePaths) {
      for (const side of sides) {
        tasks.push({ path, viewport, side, entries: [], durationMs: 0 });
      }
    }
  }

  let completed = 0;
  const total = tasks.length;
  const t0 = Date.now();
  const progress = ora(`0/${total} captures`).start();

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser({ headless: true });

    await runWithConcurrency(tasks, concurrency, async (task) => {
      const url = new URL(task.path, task.side === "prod" ? opts.prod : opts.cand).toString();
      try {
        const cap = await captureLite(browser!, task.viewport, task.side, url);
        task.entries = cap.entries;
        task.durationMs = cap.durationMs;
      } catch (err) {
        task.error = (err as Error).message;
      } finally {
        completed++;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        const etaSec = completed > 0 ? Math.round(((Date.now() - t0) / completed) * (total - completed) / 1000) : 0;
        progress.text = `${completed}/${total} · ${elapsed}s · ETA ${etaSec}s · ${task.side === "prod" ? chalk.cyan("prod") : chalk.magenta("cand")} ${task.path} (${task.viewport})`;
      }
    });
    progress.succeed(`${total} capture(s) em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Aggregate cand entries
    const candEntries: NetworkEntry[] = [];
    const prodEntries: NetworkEntry[] = [];
    for (const t of tasks) {
      if (t.side === "cand") candEntries.push(...t.entries);
      else prodEntries.push(...t.entries);
    }

    const candReport = buildCacheReport(candEntries, opts.cand);
    const prodReport = prodEntries.length > 0 ? buildCacheReport(prodEntries, opts.prod) : null;

    const html = buildCacheHtml(opts, candReport, prodReport, tasks);
    writeRunReportHtml(paths.runDir, html);
    writeFileSync(
      join(paths.runDir, "cache.json"),
      `${JSON.stringify(
        {
          schemaVersion: "0.1",
          prodUrl: opts.prod,
          candUrl: opts.cand,
          pagesAnalyzed: pagePaths.length,
          candReport: {
            hitRate: candReport.hitRate,
            opportunities: candReport.opportunities.length,
            byCategory: candReport.byCategory,
          },
          prodReport: prodReport ? { hitRate: prodReport.hitRate } : null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    printSummary(candReport, prodReport);
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

interface LiteCapture {
  entries: NetworkEntry[];
  durationMs: number;
}

async function captureLite(
  browser: Browser,
  viewport: Viewport,
  side: Side,
  url: string,
): Promise<LiteCapture> {
  const ctx = await newContext(browser, { viewport, cohortCookieValue: "control" });
  const page: Page = await ctx.newPage();
  try {
    const cap = await capturePage(page, {
      url,
      side,
      viewport,
      screenshotPath: "",
      settleMs: 800,
      timeoutMs: 15_000,
      scrollToLoad: false,
      skipScreenshot: true,
      fast: true,
    });
    return { entries: cap.network, durationMs: cap.durationMs };
  } finally {
    await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
  }
}

async function discoverPagePaths(
  prodUrl: string,
  opts: CacheOptions,
  limit: number,
): Promise<string[]> {
  if (opts.urls) {
    if (opts.urls.endsWith(".txt") || opts.urls.endsWith(".list") || opts.urls.startsWith("file:")) {
      const path = opts.urls.replace(/^file:\/\//, "");
      if (existsSync(path)) {
        return readFileSync(path, "utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#"))
          .map((s) => (s.startsWith("/") ? s : `/${s}`));
      }
    }
    return opts.urls
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith("/") || s.startsWith("http") ? s : `/${s}`));
  }
  const all = await resolveSitemapUrls(prodUrl);
  if (all.length === 0) return ["/"];
  const seen = new Set<string>(["/"]);
  const out: string[] = ["/"];
  const buckets = new Map<string, string[]>();
  for (const u of all) {
    let p = "/";
    try {
      p = new URL(u).pathname || "/";
    } catch {
      continue;
    }
    if (seen.has(p)) continue;
    const seg = p.split("/").filter(Boolean)[0] ?? "_root";
    const arr = buckets.get(seg) ?? [];
    arr.push(p);
    buckets.set(seg, arr);
  }
  const keys = [...buckets.keys()];
  let idx = 0;
  while (out.length < limit && keys.some((k) => (buckets.get(k)?.length ?? 0) > 0)) {
    const k = keys[idx % keys.length]!;
    const next = buckets.get(k)!.shift();
    if (next && !seen.has(next)) {
      out.push(next);
      seen.add(next);
    }
    idx++;
  }
  return out.slice(0, limit);
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

function printSummary(cand: CacheReport, prod: CacheReport | null): void {
  console.log("");
  console.log(chalk.bold("  Summary:"));
  console.log(
    `    ${chalk.green(`${(cand.hitRate * 100).toFixed(0)}%`)} cache hit rate (cand)${prod ? `  ${chalk.dim(`(prod: ${(prod.hitRate * 100).toFixed(0)}%)`)}` : ""}`,
  );
  console.log(`    ${chalk.red(cand.opportunities.length)} oportunidades — assets cacheable em MISS`);
  console.log(`    ${chalk.dim(cand.total)} requests analisados, ${chalk.dim(`${(cand.totalBytes / 1024).toFixed(0)} KB`)}`);
  if (cand.opportunities.length > 0) {
    console.log("");
    console.log(chalk.bold("  Top 5 oportunidades:"));
    for (const opp of cand.opportunities.slice(0, 5)) {
      const sizeKb = ((opp.entry.bytes ?? 0) / 1024).toFixed(0);
      try {
        const u = new URL(opp.entry.url);
        console.log(`    ${chalk.red(`${sizeKb} KB`)} ${chalk.dim(`[${opp.category}]`)} ${u.pathname}`);
      } catch {
        console.log(`    ${chalk.red(`${sizeKb} KB`)} ${chalk.dim(`[${opp.category}]`)} ${opp.entry.url}`);
      }
    }
  }
}

function esc(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildCacheHtml(
  opts: CacheOptions,
  cand: CacheReport,
  prod: CacheReport | null,
  tasks: PageNetwork[],
): string {
  const hitPct = (cand.hitRate * 100).toFixed(0);
  const prodHitPct = prod ? (prod.hitRate * 100).toFixed(0) : "—";
  const oppBytes = cand.opportunities.reduce((s, r) => s + (r.entry.bytes ?? 0), 0);
  const totalPages = new Set(tasks.map((t) => t.path)).size;

  const oppRows = cand.opportunities
    .slice(0, 100)
    .map((o) => {
      const sizeKb = o.entry.bytes != null ? (o.entry.bytes / 1024).toFixed(1) : "—";
      const u = o.entry.url;
      return `<tr>
        <td class="num">${sizeKb} KB</td>
        <td><span class="net-cat cat-${o.category}">${o.category}</span></td>
        <td><span class="net-cache cache-miss">${o.decision === "unknown" ? "miss?" : o.decision}</span></td>
        <td class="url-cell"><a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(humanizeUrl(u))}</a></td>
      </tr>`;
    })
    .join("");

  const catRows = (
    Object.entries(cand.byCategory) as Array<[string, { count: number; bytes: number; hitRate: number }]>
  )
    .filter(([, i]) => i.count > 0)
    .sort(([, a], [, b]) => b.bytes - a.bytes)
    .map(([cat, i]) => {
      const hr = (i.hitRate * 100).toFixed(0);
      const cls = i.hitRate > 0.8 ? "good" : i.hitRate > 0.4 ? "neutral" : "bad";
      return `<tr>
        <td><span class="net-cat cat-${cat}">${cat}</span></td>
        <td class="num">${i.count}</td>
        <td class="num">${(i.bytes / 1024).toFixed(0)} KB</td>
        <td class="num ${cls === "good" ? "delta-good" : cls === "bad" ? "delta-bad" : "delta-neutral"}">${hr}%</td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"/><title>parity cache</title>
<style>
:root{--bg:#0b0e14;--card:#131720;--elev:#1a1f2b;--border:#232a37;--fg:#e6e8eb;--muted:#8a93a6;--green:#2ec27e;--red:#e5484d;--yellow:#f5a623;--accent:#4f7df3}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:var(--bg);color:var(--fg);padding:24px;max-width:1200px;margin:0 auto;line-height:1.5}
h1{font-size:20px;margin:0 0 8px 0}
.urls{color:var(--muted);font-size:13px;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:14px}
.card h2{font-size:14px;margin:0 0 12px 0;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em}
.hero-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.hero-stat{background:var(--elev);border-radius:10px;padding:16px;text-align:center}
.big-num{font-size:40px;font-weight:700;line-height:1}
.big-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;margin-top:6px}
.hero-meta{font-size:12px;color:var(--muted);margin-top:6px}
.delta-good{color:var(--green);font-weight:600}
.delta-bad{color:var(--red);font-weight:600}
.delta-neutral{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left}
th{color:var(--muted);font-weight:500}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.url-cell{max-width:540px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.url-cell a{color:var(--accent);text-decoration:none}
.url-cell a:hover{text-decoration:underline}
.net-cat{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;text-transform:uppercase;letter-spacing:0.04em;font-weight:600}
.cat-document{background:rgba(79,125,243,0.15);color:#88aaff}
.cat-static-asset{background:rgba(46,194,126,0.15);color:var(--green)}
.cat-image{background:rgba(245,166,35,0.15);color:var(--yellow)}
.cat-font{background:rgba(184,110,255,0.15);color:#b86eff}
.cat-api{background:rgba(54,179,255,0.15);color:#36b3ff}
.cat-third-party{background:rgba(138,147,166,0.15);color:var(--muted)}
.cat-other{background:var(--elev);color:var(--muted)}
.net-cache{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase}
.cache-hit{background:rgba(46,194,126,0.15);color:var(--green)}
.cache-miss{background:rgba(229,72,77,0.15);color:var(--red)}
.cache-bypass{background:rgba(138,147,166,0.15);color:var(--muted)}
.hint{font-size:11px;color:var(--muted);margin-top:8px}
details>summary{cursor:pointer;list-style:none;padding:4px 0}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"▶";color:var(--muted);font-size:9px;margin-right:8px;display:inline-block;transition:transform .15s}
details[open]>summary::before{transform:rotate(90deg)}
</style></head><body>
<h1>parity cache</h1>
<div class="urls"><strong>cand</strong> ${esc(opts.cand)} · ${totalPages} páginas analisadas · ${tasks.length} captures</div>

<div class="card">
  <div class="hero-grid">
    <div class="hero-stat">
      <div class="big-num">${hitPct}%</div>
      <div class="big-label">cache hit rate (cand)</div>
      <div class="hero-meta">${prod ? `prod: ${prodHitPct}%` : "sem comparação prod"}</div>
    </div>
    <div class="hero-stat">
      <div class="big-num">${cand.opportunities.length}</div>
      <div class="big-label">oportunidades</div>
      <div class="hero-meta">${(oppBytes / 1024).toFixed(0)} KB cacheável que vai MISS</div>
    </div>
    <div class="hero-stat">
      <div class="big-num">${cand.total}</div>
      <div class="big-label">requests analisados</div>
      <div class="hero-meta">${(cand.totalBytes / 1024).toFixed(0)} KB total</div>
    </div>
  </div>
  <div class="hint">Foco em cand — prod é só referência. Oportunidade = static-asset/image/font com hash na URL que está MISS em cand.</div>
</div>

<div class="card">
  <h2>Por categoria (cand)</h2>
  <table><thead><tr><th>Categoria</th><th class="num">Requests</th><th class="num">Bytes</th><th class="num">Hit rate</th></tr></thead><tbody>${catRows}</tbody></table>
</div>

<details class="card" open>
  <summary><h2 style="display:inline;color:var(--fg)">❌ Top oportunidades — ${cand.opportunities.length} cacheable em MISS</h2></summary>
  <div class="hint">Adicionar cache rule pra essas reduz ${(oppBytes / 1024).toFixed(0)} KB / ${cand.opportunities.length} requests.</div>
  <table><thead><tr><th class="num">Size</th><th>Tipo</th><th>Cache</th><th>URL</th></tr></thead><tbody>${oppRows}</tbody></table>
</details>

</body></html>`;
}

function humanizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}${u.search ? `${u.search.slice(0, 40)}${u.search.length > 40 ? "…" : ""}` : ""}`;
  } catch {
    return url.slice(0, 120);
  }
}
