import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Browser, Page } from "playwright";
import { cacheCoverage } from "../checks/cache-coverage.ts";
import type { CheckContext } from "../checks/index.ts";
import { resolveSitemapUrls } from "../diff/sitemap.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { capturePage } from "../engine/collect.ts";
import { renderHtmlReport } from "../report/render.ts";
import {
  createRunDir,
  newRunId,
  writeRunReportHtml,
  writeRunReportJson,
} from "../storage/fs.ts";
import type {
  CheckResult,
  FlowCapture,
  FlowName,
  Issue,
  PageCapture,
  ParityIgnore,
  ParityRc,
  Run,
  Side,
  Verdict,
  Viewport,
} from "../types/schema.ts";

export interface CacheOptions {
  prod: string;
  cand: string;
  urls?: string;
  pages?: number;
  viewports?: string;
  concurrency?: number;
  candOnly?: boolean;
  output: string;
  open?: boolean;
}

interface CaptureTask {
  path: string;
  viewport: Viewport;
  side: Side;
  capture?: PageCapture;
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
  const t0 = Date.now();

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
  const tasks: CaptureTask[] = [];
  for (const viewport of viewports) {
    for (const path of pagePaths) {
      for (const side of sides) {
        tasks.push({ path, viewport, side });
      }
    }
  }

  let completed = 0;
  const total = tasks.length;
  const progress = ora(`0/${total} captures`).start();

  let browser: Browser | null = null;
  try {
    browser = await launchBrowser({ headless: true });

    await runWithConcurrency(tasks, concurrency, async (task) => {
      const url = new URL(task.path, task.side === "prod" ? opts.prod : opts.cand).toString();
      try {
        task.capture = await captureLite(browser!, task.viewport, task.side, url);
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

    // Build canonical Run object using the captures
    const allPageCaptures: PageCapture[] = tasks
      .map((t) => t.capture)
      .filter((c): c is PageCapture => !!c);

    // Group into FlowCaptures by side+viewport for the renderer
    const flowCaptures: FlowCapture[] = [];
    for (const viewport of viewports) {
      for (const side of sides) {
        const pages = allPageCaptures.filter((p) => p.side === side && p.viewport === viewport);
        if (pages.length === 0) continue;
        flowCaptures.push({
          flow: "homepage" as FlowName,
          side,
          viewport,
          pages,
          totalDurationMs: pages.reduce((s, p) => s + p.durationMs, 0),
        });
      }
    }

    // Run only the cache-coverage check
    const rc: ParityRc = { cep: "01310-100", selectors: {}, skipSteps: [] };
    const ignore: ParityIgnore = {
      ignoreSelectorsVisual: [],
      ignoreRequestPatterns: [],
      ignoreConsolePatterns: [],
      ignoreMetaKeys: [],
      toleratedDomDrift: {},
    };
    const checkCtx: CheckContext = {
      prodPages: allPageCaptures.filter((p) => p.side === "prod"),
      candPages: allPageCaptures.filter((p) => p.side === "cand"),
      prodFlows: flowCaptures.filter((f) => f.side === "prod"),
      candFlows: flowCaptures.filter((f) => f.side === "cand"),
      rc,
      ignore,
      outDir: paths.runDir,
      viewports,
    };
    const cacheResult: CheckResult = cacheCoverage(checkCtx);

    const allIssues: Issue[] = cacheResult.issues;
    const verdict = computeVerdict([cacheResult], allIssues);
    const run: Run = {
      schemaVersion: "0.1",
      id: runId,
      timestamp: new Date().toISOString(),
      prodUrl: opts.prod,
      candUrl: opts.cand,
      flows: ["homepage" as FlowName],
      viewports,
      cep: rc.cep,
      durationMs: Date.now() - t0,
      verdict,
      topIssues: allIssues.slice(0, 10),
      issues: allIssues,
      checks: [cacheResult],
      flowCaptures,
    };

    writeRunReportJson(paths.runDir, run);
    const html = renderHtmlReport(run, paths.runDir);
    writeRunReportHtml(paths.runDir, html);

    // Also keep a focused cache.json for CI
    writeFileSync(
      join(paths.runDir, "cache.json"),
      `${JSON.stringify(
        {
          schemaVersion: "0.1",
          prodUrl: opts.prod,
          candUrl: opts.cand,
          pagesAnalyzed: pagePaths.length,
          cacheCheck: cacheResult.data,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    printSummary(cacheResult);
    console.log("");
    console.log(chalk.dim(`  → ${paths.reportHtml}`));
    console.log(chalk.dim(`  💡 use 'parity serve ${runId}' pra preview com iframe proxy ativo`));
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

function computeVerdict(checks: CheckResult[], issues: Issue[]): Verdict {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) counts[i.severity]++;
  const checksPassed = checks.filter((c) => c.status === "pass").length;
  const checksFailed = checks.filter((c) => c.status === "fail").length;
  const checksSkipped = checks.filter((c) => c.status === "skipped").length;
  const checksWarn = checks.filter((c) => c.status === "warn").length;
  const score = Math.max(
    0,
    100 - counts.critical * 20 - counts.high * 8 - counts.medium * 3 - counts.low * 1,
  );
  const status: Verdict["status"] =
    counts.critical > 0 || checksFailed > 0
      ? "fail"
      : counts.high > 0 || checksWarn > 0
        ? "warn"
        : "pass";
  return {
    status,
    score,
    critical: counts.critical,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    checksRun: checks.length,
    checksPassed,
    checksFailed,
    checksSkipped,
  };
}

async function captureLite(
  browser: Browser,
  viewport: Viewport,
  side: Side,
  url: string,
): Promise<PageCapture> {
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
    return cap;
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

function printSummary(check: CheckResult): void {
  const data = (check.data ?? {}) as {
    hitRate?: number;
    prodHitRate?: number;
    opportunityCount?: number;
    opportunityBytes?: number;
  };
  console.log("");
  console.log(chalk.bold("  Summary:"));
  console.log(
    `    ${chalk.green(`${((data.hitRate ?? 0) * 100).toFixed(0)}%`)} cache hit rate (cand)${data.prodHitRate != null ? `  ${chalk.dim(`(prod: ${(data.prodHitRate * 100).toFixed(0)}%)`)}` : ""}`,
  );
  console.log(`    ${chalk.red(data.opportunityCount ?? 0)} oportunidades — ${((data.opportunityBytes ?? 0) / 1024).toFixed(0)} KB`);
  console.log(`    ${chalk.dim(check.issues.length)} issue(s) gerada(s)`);
}
