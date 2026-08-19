import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import {
  ALL_CHECKS_BY_NAME,
  type CheckContext,
  FLOW_DEPENDENT_CHECKS,
  getCheckByName,
} from "../checks/index.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { capturePage, installVitalsCollector } from "../engine/collect.ts";
import { loadParityIgnore, loadParityRc } from "../ignore/parser.ts";
import type { CheckResult, Issue, PageCapture, Side, Viewport } from "../types/schema.ts";

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

const VALID_VIEWPORTS: ReadonlySet<string> = new Set(["mobile", "desktop", "tablet"]);

/**
 * `parity check <name>` — run ONE check (issue #31, PR 4).
 *
 * Skips the full `parity run` pipeline (sitemap discovery, 13 sibling
 * checks, LLM aggregation). Captures only the page(s) the user asked for,
 * then dispatches to a single check function from `ALL_CHECKS_BY_NAME`.
 */
export async function checkCommand(opts: CheckCommandOptions): Promise<number> {
  // Use the safe lookup helper instead of plain object indexing — cubic
  // flagged that `record[userInput]` exposes prototype keys like
  // `__proto__` / `toString` (would resolve to truthy Object methods,
  // bypassing the "not found" branch).
  const check = getCheckByName(opts.name);
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

  // Reject unknown viewport tokens loud-and-clear instead of silently
  // dropping them (cubic flagged the previous `filter` as
  // "false-confidence-producing"): `parity check x --viewports phone`
  // would have proceeded with no viewports → exit 2 with a generic
  // message, instead of the precise "phone is not a valid viewport".
  const rawViewports = opts.viewports
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const invalid = rawViewports.filter((v) => !VALID_VIEWPORTS.has(v));
  if (invalid.length > 0) {
    console.error(
      chalk.red(`viewport(s) inválido(s): ${invalid.join(", ")} (use mobile, desktop ou tablet)`),
    );
    return 2;
  }
  if (rawViewports.length === 0) {
    console.error(chalk.red(`viewports inválido: '${opts.viewports}'`));
    return 2;
  }
  const viewports = rawViewports as Viewport[];

  let prodUrl: URL;
  let candUrl: URL;
  try {
    prodUrl = new URL(opts.prod);
    candUrl = new URL(opts.cand);
  } catch {
    console.error(chalk.red("--prod ou --cand inválido"));
    return 2;
  }

  // `--page` must be a path, NOT an absolute URL. Cubic flagged that
  // `new URL("https://other.com/", base)` returns the absolute URL,
  // silently overriding --prod / --cand. Reject anything that parses
  // as an absolute URL (scheme present).
  const pagePath = (opts.page || "/").trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(pagePath)) {
    console.error(
      chalk.red(
        `--page deve ser um caminho relativo (e.g. "/bota-tudao-2025"), recebido: ${pagePath}`,
      ),
    );
    return 2;
  }

  const rc = loadParityRc();
  const ignore = loadParityIgnore();

  // Portable, per-run temp dir. Cubic flagged hardcoded `/tmp` paths
  // (not portable to Windows, collide between concurrent runs).
  const runDir = mkdtempSync(join(tmpdir(), "parity-check-"));

  const browser = await launchBrowser({ headless: true });
  const prodPages: PageCapture[] = [];
  const candPages: PageCapture[] = [];
  const captureErrors: Array<{ side: Side; viewport: Viewport; message: string }> = [];
  try {
    for (const viewport of viewports) {
      for (const side of ["prod", "cand"] as Side[]) {
        const baseUrl = side === "prod" ? prodUrl.toString() : candUrl.toString();
        const fullUrl = new URL(pagePath, baseUrl).toString();
        const ctx = await newContext(browser, { viewport });
        await installVitalsCollector(ctx);
        const p = await ctx.newPage();
        try {
          const cap = await capturePage(p, {
            url: fullUrl,
            side,
            viewport,
            screenshotPath: join(runDir, `${opts.name}-${viewport}-${side}.png`),
            settleMs: 1200,
            timeoutMs: 25_000,
            fast: true,
            scrollToLoad: false,
            skipScreenshot: false,
          });
          (side === "prod" ? prodPages : candPages).push(cap);
        } catch (err) {
          // Funnel capture failures into the same shape as check failures
          // so the user sees a structured error message at the end
          // instead of a raw stack trace from a deep playwright error.
          captureErrors.push({
            side,
            viewport,
            message: (err as Error).message ?? "capture threw",
          });
        } finally {
          await p.close().catch(() => undefined);
          await ctx.close().catch(() => undefined);
        }
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  // If every single page capture failed, there is nothing for the check
  // to operate on. Exit early with a structured message rather than
  // calling the check with empty inputs and getting a misleading
  // "passed (no issues)" result.
  if (prodPages.length === 0 && candPages.length === 0) {
    console.error(chalk.red("\n  ✖ todas as capturas falharam — não há nada pra rodar o check"));
    for (const e of captureErrors) {
      console.error(chalk.red(`    - ${e.viewport}/${e.side}: ${e.message}`));
    }
    return 2;
  }

  const checkCtx: CheckContext = {
    prodPages,
    candPages,
    prodFlows: [],
    candFlows: [],
    rc,
    ignore,
    outDir: runDir,
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
  printResult(result, {
    prod: opts.prod,
    cand: opts.cand,
    page: pagePath,
    viewports,
    json: opts.json === true,
    captureErrors,
  });
  return result.status === "fail" ? 1 : 0;
}

function printResult(
  result: CheckResult,
  meta: {
    prod: string;
    cand: string;
    page: string;
    viewports: Viewport[];
    json: boolean;
    captureErrors: Array<{ side: Side; viewport: Viewport; message: string }>;
  },
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
  if (meta.captureErrors.length > 0) {
    for (const e of meta.captureErrors) {
      console.log(chalk.yellow(`  ⚠ captura falhou em ${e.viewport}/${e.side}: ${e.message}`));
    }
    console.log("");
  }
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
