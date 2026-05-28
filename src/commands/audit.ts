import { writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Browser } from "playwright";
import { type PageAuditResult, aggregateAudit, runAuditForPage } from "../audit/index.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { capturePage, installVitalsCollector } from "../engine/collect.ts";
import { renderAuditHtmlReport } from "../report/audit-render.ts";
import { createRunDir, newRunId } from "../storage/fs.ts";
import type { Issue, PageCapture, Viewport } from "../types/schema.ts";

export interface AuditCommandOptions {
  url: string;
  viewport: string;
  /** Comma-separated paths. Default: "/" only. */
  pages: string;
  output: string;
  open?: boolean;
  json?: boolean;
  /** Comma-separated severities that cause exit 1. */
  failOn: string;
}

const SEVERITY_RANK: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * `parity audit` — single-site absolute audit.
 *
 * No prod×cand comparison. Captures each requested page once, runs the
 * five absolute audit modules (vitals, console, network, images, seo),
 * aggregates, writes a focused HTML report.
 *
 * Designed for the "I want to know what's wrong with THIS site, not
 * compare against another" workflow — e.g. before a launch, after a
 * deploy, or auditing a partner site.
 */
export async function auditCommand(opts: AuditCommandOptions): Promise<number> {
  const viewport = parseViewport(opts.viewport);
  if (!viewport) {
    console.error(chalk.red(`viewport inválido: ${opts.viewport} (use mobile|desktop|tablet)`));
    return 2;
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(opts.url);
  } catch {
    console.error(chalk.red(`--url inválido: ${opts.url}`));
    return 2;
  }

  const pages = parsePages(opts.pages);
  const failOn = (opts.failOn || "critical,high")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Issue["severity"][];

  const runId = newRunId();
  const paths = createRunDir(opts.output, runId);
  const startedAt = Date.now();

  if (!opts.json) {
    console.log(chalk.bold(`\n  parity audit ${runId}`));
    console.log(chalk.dim(`  url:      ${opts.url}`));
    console.log(chalk.dim(`  viewport: ${viewport}`));
    console.log(chalk.dim(`  páginas:  ${pages.join(", ")}\n`));
  }

  const spinner = opts.json ? null : ora("Lançando browser…").start();
  let browser: Browser | null = null;
  const captures: PageCapture[] = [];
  try {
    browser = await launchBrowser({ headless: true });
    const ctx = await newContext(browser, { viewport });
    await installVitalsCollector(ctx);
    let done = 0;
    for (const path of pages) {
      const fullUrl = new URL(path, baseUrl.toString()).toString();
      if (spinner) spinner.text = `[${++done}/${pages.length}] capturando ${path}…`;
      const page = await ctx.newPage();
      try {
        const cap = await capturePage(page, {
          url: fullUrl,
          side: "cand",
          viewport,
          screenshotPath: join(paths.screenshotsDir, `audit-${safePath(path)}-${viewport}.png`),
          settleMs: 1500,
          timeoutMs: 30_000,
          fast: false,
          scrollToLoad: true,
        });
        captures.push(cap);
      } catch (err) {
        // Soft-fail: log and continue with other pages.
        if (spinner) spinner.warn(`falhou em ${path}: ${(err as Error).message}`);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
    await ctx.close().catch(() => undefined);
    if (spinner) spinner.succeed(`Capturado ${captures.length}/${pages.length} página(s)`);
  } finally {
    await browser?.close().catch(() => undefined);
  }

  if (captures.length === 0) {
    console.error(chalk.red("\n  ✖ nenhuma captura completada"));
    return 2;
  }

  // Run all 5 audit modules per page.
  const auditSpinner = opts.json ? null : ora("Rodando audit checks…").start();
  const pageResults: PageAuditResult[] = captures.map(runAuditForPage);
  const result = aggregateAudit(pageResults);
  if (auditSpinner) auditSpinner.succeed(`${result.totals.issues} issue(s) encontrada(s)`);

  // Persist HTML + JSON.
  const durationMs = Date.now() - startedAt;
  const html = renderAuditHtmlReport({
    result,
    url: opts.url,
    generatedAt: new Date().toISOString(),
    durationMs,
  });
  const reportPath = paths.reportHtml;
  const jsonPath = paths.reportJson;
  writeFileSync(reportPath, html, "utf8");
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        runId,
        url: opts.url,
        viewport,
        requestedPages: pages,
        timestamp: new Date(startedAt).toISOString(),
        durationMs,
        ...result,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Output.
  if (opts.json) {
    console.log(
      JSON.stringify({
        runId,
        url: opts.url,
        viewport,
        pages,
        durationMs,
        totals: result.totals,
        reportHtml: reportPath,
        reportJson: jsonPath,
      }),
    );
  } else {
    printSummary(result, pages, reportPath);
  }

  // Exit code based on --fail-on.
  const worst = result.allIssues[0];
  if (worst) {
    const worstSev = result.allIssues
      .map((i) => i.severity)
      .reduce((a, b) => (SEVERITY_RANK[a] < SEVERITY_RANK[b] ? a : b), worst.severity);
    if (failOn.includes(worstSev)) {
      if (opts.open) await openReport(reportPath);
      return 1;
    }
  }
  if (opts.open) await openReport(reportPath);
  return 0;
}

function parseViewport(raw: string): Viewport | null {
  return raw === "mobile" || raw === "desktop" || raw === "tablet" ? raw : null;
}

function parsePages(raw: string): string[] {
  if (!raw || raw.trim().length === 0) return ["/"];
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ["/"];
}

function safePath(path: string): string {
  return path.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "root";
}

function printSummary(
  result: ReturnType<typeof aggregateAudit>,
  pages: string[],
  reportPath: string,
): void {
  const { totals } = result;
  const verdict =
    totals.critical > 0
      ? chalk.red.bold("✖ FAIL")
      : totals.high > 0
        ? chalk.red("✖ FAIL")
        : totals.issues > 0
          ? chalk.yellow("⚠ WARN")
          : chalk.green.bold("✓ PASS");
  console.log(`\n  ${verdict}`);
  console.log(`  ${totals.pages} página(s) · ${totals.issues} issue(s)`);
  console.log(
    `  ${chalk.red(`${totals.critical} critical`)} · ${chalk.red(`${totals.high} high`)} · ${chalk.yellow(`${totals.medium} medium`)} · ${chalk.dim(`${totals.low} low`)}`,
  );

  // Show top 5 highest-severity issues.
  const top = result.allIssues.slice(0, 5);
  if (top.length > 0) {
    console.log("\n  Top issues:");
    for (const issue of top) {
      const sevTag =
        issue.severity === "critical"
          ? chalk.red.bold("[critical]")
          : issue.severity === "high"
            ? chalk.red("[high]    ")
            : issue.severity === "medium"
              ? chalk.yellow("[medium]  ")
              : chalk.dim("[low]     ");
      console.log(`    ${sevTag} ${issue.summary.slice(0, 200)}`);
    }
  }
  console.log(`\n  → ${reportPath}`);
  void pages;
}

async function openReport(path: string): Promise<void> {
  try {
    const { default: open } = await import("open");
    await open(path);
  } catch {
    // open package missing or platform doesn't support it; non-fatal.
  }
}
