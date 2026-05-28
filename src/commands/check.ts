import chalk from "chalk";
import {
  ALL_CHECKS_BY_NAME,
  type CheckContext,
  FLOW_DEPENDENT_CHECKS,
} from "../checks/index.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { capturePage, installVitalsCollector } from "../engine/collect.ts";
import { loadParityIgnore, loadParityRc } from "../ignore/parser.ts";
import type {
  CheckResult,
  Issue,
  PageCapture,
  Side,
  Viewport,
} from "../types/schema.ts";

export interface CheckCommandOptions {
  name: string;
  prod: string;
  cand: string;
  viewports: string;
  page: string;
  json?: boolean;
}

const SEVERITY_RANK: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * `parity check <name>` — run ONE check (issue #31, PR 4).
 *
 * Skips the full `parity run` pipeline (sitemap discovery, 13 sibling
 * checks, LLM aggregation). Captures only the page(s) the user asked for,
 * then dispatches to a single check function from `ALL_CHECKS_BY_NAME`.
 *
 * Use case from the issue: "I fixed one thing on /bota-tudao-2025 and
 * want to verify only the visual-regression check passes now". Today
 * that takes 5 minutes via `parity run`; here it takes ~10 seconds.
 *
 * Flow-dependent checks (`purchase-journey-flow`,
 * `cart-reveal-mode-divergence`) are blocked with a clear message — they
 * need step captures that this command's lean pipeline does not produce.
 */
export async function checkCommand(opts: CheckCommandOptions): Promise<number> {
  const check = ALL_CHECKS_BY_NAME[opts.name];
  if (!check) {
    console.error(chalk.red(`check '${opts.name}' não existe.\n`));
    console.error(chalk.dim("Checks disponíveis:"));
    for (const name of Object.keys(ALL_CHECKS_BY_NAME).sort()) {
      console.error(chalk.dim(`  - ${name}`));
    }
    return 2;
  }
  if (FLOW_DEPENDENT_CHECKS.has(opts.name)) {
    console.error(
      chalk.red(
        `check '${opts.name}' depende de captura de purchase-journey (steps),\nque o 'parity check' não roda.\n`,
      ),
    );
    console.error(
      chalk.dim(
        "Use:\n  parity journey --prod ... --cand ...\n  ou\n  parity run --flows purchase-journey --prod ... --cand ...",
      ),
    );
    return 2;
  }

  const viewports = opts.viewports
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Viewport => s === "mobile" || s === "desktop" || s === "tablet");
  if (viewports.length === 0) {
    console.error(chalk.red(`viewports inválido: '${opts.viewports}'`));
    return 2;
  }
  let prodUrl: URL;
  let candUrl: URL;
  try {
    prodUrl = new URL(opts.prod);
    candUrl = new URL(opts.cand);
  } catch {
    console.error(chalk.red("--prod ou --cand inválido"));
    return 2;
  }
  const page = opts.page || "/";

  const rc = loadParityRc();
  const ignore = loadParityIgnore();

  const browser = await launchBrowser({ headless: true });
  const prodPages: PageCapture[] = [];
  const candPages: PageCapture[] = [];
  try {
    for (const viewport of viewports) {
      for (const side of ["prod", "cand"] as Side[]) {
        const baseUrl = side === "prod" ? prodUrl.toString() : candUrl.toString();
        const fullUrl = new URL(page, baseUrl).toString();
        const ctx = await newContext(browser, { viewport });
        await installVitalsCollector(ctx);
        const p = await ctx.newPage();
        try {
          const cap = await capturePage(p, {
            url: fullUrl,
            side,
            viewport,
            screenshotPath: `/tmp/parity-check-${opts.name}-${viewport}-${side}.png`,
            settleMs: 1200,
            timeoutMs: 25_000,
            fast: true,
            scrollToLoad: false,
            skipScreenshot: false,
          });
          (side === "prod" ? prodPages : candPages).push(cap);
        } finally {
          await p.close().catch(() => undefined);
          await ctx.close().catch(() => undefined);
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const checkCtx: CheckContext = {
    prodPages,
    candPages,
    prodFlows: [],
    candFlows: [],
    rc,
    ignore,
    outDir: "/tmp",
    viewports,
  };

  let result: CheckResult;
  const start = Date.now();
  try {
    result = await check(checkCtx);
  } catch (err) {
    result = {
      name: opts.name,
      status: "fail",
      severity: "medium",
      durationMs: Date.now() - start,
      summary: `check threw: ${(err as Error).message}`,
      issues: [],
    };
  }
  printResult(result, { prod: opts.prod, cand: opts.cand, page, viewports, json: opts.json === true });
  return result.status === "fail" ? 1 : 0;
}

function printResult(
  result: CheckResult,
  meta: { prod: string; cand: string; page: string; viewports: Viewport[]; json: boolean },
): void {
  if (meta.json) {
    console.log(JSON.stringify({ ...meta, result }));
    return;
  }
  const statusColor =
    result.status === "pass"
      ? chalk.green
      : result.status === "warn"
        ? chalk.yellow
        : result.status === "skipped"
          ? chalk.dim
          : chalk.red;
  console.log(chalk.bold(`\n  ${result.name}`));
  console.log(chalk.dim(`  ${meta.viewports.join(", ")} · ${meta.page}`));
  console.log(chalk.dim(`  ${meta.prod} ↔ ${meta.cand}\n`));
  console.log(`  status: ${statusColor(result.status)} · ${result.summary}`);
  if (result.issues.length === 0) {
    console.log(chalk.dim("  (sem issues)"));
    return;
  }
  const sorted = [...result.issues].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  console.log("");
  for (const issue of sorted) {
    const tag =
      issue.severity === "critical"
        ? chalk.red.bold("[critical]")
        : issue.severity === "high"
          ? chalk.red("[high]    ")
          : issue.severity === "medium"
            ? chalk.yellow("[medium]  ")
            : chalk.dim("[low]     ");
    console.log(`  ${tag} ${issue.summary}`);
  }
}
