import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Browser, Page } from "playwright";
import { cacheCoverage } from "../checks/cache-coverage.ts";
import type { CheckContext } from "../checks/index.ts";
import { pairCaptures } from "../checks/lib/pairing.ts";
import { webVitalsMobile } from "../checks/web-vitals.ts";
import { resolveSitemapUrls } from "../diff/sitemap.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { capturePage, installVitalsCollector } from "../engine/collect.ts";
import { computeVerdict } from "../engine/verdict.ts";
import { renderHtmlReport } from "../report/render.ts";
import { createRunDir, newRunId, writeRunReportHtml, writeRunReportJson } from "../storage/fs.ts";
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
  Viewport,
} from "../types/schema.ts";

export interface VitalsOptions {
  prod: string;
  cand: string;
  urls?: string;
  limit?: number;
  viewports: string;
  concurrency?: number;
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

export async function vitalsCommand(opts: VitalsOptions): Promise<number> {
  const viewports = opts.viewports
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Viewport => s === "mobile" || s === "desktop");
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));

  const runId = newRunId();
  const paths = createRunDir(opts.output, runId);
  const t0 = Date.now();

  console.log(chalk.bold(`\n  parity vitals ${runId}`));
  console.log(chalk.dim(`  prod: ${opts.prod}`));
  console.log(chalk.dim(`  cand: ${opts.cand}`));

  const discoverSpinner = ora("Descobrindo páginas…").start();
  const pagePaths = await discoverPagePaths(opts.prod, opts);
  if (pagePaths.length === 0) {
    discoverSpinner.fail("Nenhuma página descoberta");
    return 2;
  }
  discoverSpinner.succeed(
    `${pagePaths.length} página(s) · viewports: ${viewports.join(",")} · concorrência: ${concurrency}`,
  );

  const tasks: CaptureTask[] = [];
  for (const viewport of viewports) {
    for (const path of pagePaths) {
      for (const side of ["prod", "cand"] as Side[]) {
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
        task.capture = await captureVitalsPage(
          browser!,
          task.viewport,
          task.side,
          url,
          paths.screenshotsDir,
        );
      } catch (err) {
        task.error = (err as Error).message;
      } finally {
        completed++;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        const etaSec =
          completed > 0
            ? Math.round((((Date.now() - t0) / completed) * (total - completed)) / 1000)
            : 0;
        progress.text = `${completed}/${total} · ${elapsed}s · ETA ${etaSec}s · ${task.side === "prod" ? chalk.cyan("prod") : chalk.magenta("cand")} ${task.path} (${task.viewport})`;
      }
    });
    progress.succeed(`${total} capture(s) em ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Assemble canonical Run
    const allPageCaptures = tasks.map((t) => t.capture).filter((c): c is PageCapture => !!c);
    const flowCaptures: FlowCapture[] = [];
    for (const viewport of viewports) {
      for (const side of ["prod", "cand"] as Side[]) {
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

    // Run the checks that make sense for vitals-only crawl
    const vitalsResult: CheckResult = webVitalsMobile(checkCtx);
    const cacheResult: CheckResult = cacheCoverage(checkCtx);
    const checks = [vitalsResult, cacheResult];

    const allIssues: Issue[] = checks.flatMap((c) => c.issues);
    const verdict = computeVerdict(checks, allIssues, {
      pagesAnalyzed: pairCaptures(checkCtx.prodPages, checkCtx.candPages).pairs.length,
    });
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
      checks,
      flowCaptures,
    };

    writeRunReportJson(paths.runDir, run);
    const html = renderHtmlReport(run, paths.runDir);
    writeRunReportHtml(paths.runDir, html);
    writeFileSync(
      join(paths.runDir, "vitals.json"),
      `${JSON.stringify(
        {
          schemaVersion: "0.1",
          prodUrl: opts.prod,
          candUrl: opts.cand,
          pagesAnalyzed: pagePaths.length,
          vitalsCheck: vitalsResult.data,
          cacheCheck: cacheResult.data,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    printSummary(vitalsResult, cacheResult);
    console.log("");
    console.log(chalk.dim(`  → ${paths.reportHtml}`));
    console.log(chalk.dim(`  💡 use 'parity serve ${runId}' pra preview iframe`));
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

async function captureVitalsPage(
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
    const safeName = url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9_-]+/gi, "_")
      .slice(0, 80);
    return await capturePage(page, {
      url,
      side,
      viewport,
      screenshotPath: `${screenshotsDir}/${safeName}-${viewport}-${side}.png`,
      settleMs: 1200,
      timeoutMs: 20_000,
      scrollToLoad: false,
      skipScreenshot: true,
      fast: true,
    });
  } finally {
    await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
  }
}

async function discoverPagePaths(prodUrl: string, opts: VitalsOptions): Promise<string[]> {
  if (opts.urls) return parseUrlList(opts.urls);
  const limit = opts.limit ?? 20;
  const all = await resolveSitemapUrls(prodUrl);
  if (all.length === 0) return ["/"];
  const seen = new Set<string>(["/"]);
  const out: string[] = ["/"];
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

function printSummary(vitals: CheckResult, cache: CheckResult): void {
  console.log("");
  console.log(chalk.bold("  Summary:"));
  console.log(`    ${vitals.summary}`);
  console.log(`    ${cache.summary}`);
}
