import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import open from "open";
import type { Browser } from "playwright";
import { runAllChecks } from "../checks/index.ts";
import type { CheckContext } from "../checks/index.ts";
import { launchBrowser, newContext, stopTracing } from "../engine/browser.ts";
import { installVitalsCollector } from "../engine/collect.ts";
import { runFlow } from "../engine/flows.ts";
import { loadParityIgnore, loadParityRc } from "../ignore/parser.ts";
import { aggregateIssues } from "../llm/aggregate-issues.ts";
import { isLlmAvailable } from "../llm/client.ts";
import { discoverSelectorsFromUrl } from "../llm/discover-selectors.ts";
import { renderHtmlReport } from "../report/render.ts";
import { compareToBaseline, loadBaseline } from "../storage/baselines.ts";
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
  Run,
  Side,
  Verdict,
  Viewport,
} from "../types/schema.ts";

export interface RunOptions {
  prod: string;
  cand: string;
  flows: string;
  viewports: string;
  cep: string;
  runs: string;
  baseline?: string;
  output: string;
  ci: boolean;
  failOn: string;
  open?: boolean;
  /** When false, skip LLM-based selector discovery (default: true if API key set) */
  autoSelectors?: boolean;
  /** Force discovery to re-run even if a cached entry exists */
  refreshSelectors?: boolean;
}

const SEVERITY_RANK: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export async function runCommand(opts: RunOptions): Promise<number> {
  const flows = opts.flows.split(",").map((s) => s.trim()) as FlowName[];
  const viewports = opts.viewports.split(",").map((s) => s.trim()) as Viewport[];
  const failOn = opts.failOn
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Issue["severity"][];

  const rc = loadParityRc();
  rc.cep = opts.cep || rc.cep;
  const ignore = loadParityIgnore();

  // LLM-based selector discovery (auto, but user .parityrc.json overrides always win)
  const wantsAutoSelectors = opts.autoSelectors !== false && isLlmAvailable();
  if (wantsAutoSelectors) {
    const discoverSpinner = ora("Descobrindo seletores via LLM (analisando home prod)…").start();
    try {
      const html = await fetchHomeHtml(opts.prod);
      if (html) {
        const discovered = await discoverSelectorsFromUrl(opts.prod, html, {
          noCache: opts.refreshSelectors === true,
        });
        if (discovered) {
          const before = rc.selectors;
          rc.selectors = {
            categoryLink: before.categoryLink ?? discovered.categoryLink,
            productCard: before.productCard ?? discovered.productCard,
            buyButton: before.buyButton ?? discovered.buyButton,
            minicartTrigger: before.minicartTrigger ?? discovered.minicartTrigger,
            cepInputPdp: before.cepInputPdp ?? discovered.cepInputPdp,
            cepInputCart: before.cepInputCart ?? discovered.cepInputCart,
            checkoutButton: before.checkoutButton ?? discovered.checkoutButton,
          };
          const added = Object.entries(discovered).filter(([_k, v]) => v).length;
          discoverSpinner.succeed(`${added} seletor(es) inferido(s) pelo LLM`);
        } else {
          discoverSpinner.warn("LLM não retornou seletores; usando defaults");
        }
      } else {
        discoverSpinner.warn("Falha ao baixar HTML da home prod; usando defaults");
      }
    } catch (err) {
      discoverSpinner.warn(`Discovery falhou: ${(err as Error).message}`);
    }
  }

  const runId = newRunId();
  const paths = createRunDir(opts.output, runId);
  const startedAt = Date.now();
  const timestamp = new Date().toISOString();

  console.log(chalk.bold(`\n  parity run ${runId}`));
  console.log(chalk.dim(`  prod: ${opts.prod}`));
  console.log(chalk.dim(`  cand: ${opts.cand}`));
  console.log(chalk.dim(`  flows: ${flows.join(", ")} · viewports: ${viewports.join(", ")} · CEP: ${rc.cep}\n`));

  const spinner = ora("Launching browser…").start();
  let browser: Browser | null = null;
  const allFlowCaptures: FlowCapture[] = [];
  const allPageCaptures: PageCapture[] = [];

  try {
    browser = await launchBrowser({ headless: true });

    for (const viewport of viewports) {
      for (const side of ["prod", "cand"] as Side[]) {
        const baseUrl = side === "prod" ? opts.prod : opts.cand;
        spinner.text = `[${viewport}/${side}] preparing context…`;
        const harPath = join(paths.harDir, `${viewport}-${side}.har`);
        const tracePath = join(paths.tracesDir, `${viewport}-${side}.zip`);
        const ctx = await newContext(browser, {
          viewport,
          harPath,
          tracesDir: paths.tracesDir,
          cohortCookieValue: "control",
        });
        await installVitalsCollector(ctx);

        for (const flow of flows) {
          spinner.text = `[${viewport}/${side}] running flow "${flow}"…`;
          const cap = await runFlow(flow, {
            baseUrl,
            side,
            viewport,
            rc,
            ctx,
            outDir: paths.screenshotsDir,
          });
          allFlowCaptures.push(cap);
          for (const p of cap.pages) allPageCaptures.push(p);
        }

        await stopTracing(ctx, tracePath).catch(() => undefined);
        await ctx.close();
      }
    }
    spinner.succeed("Coleta concluída");

    spinner.start("Rodando checks…");
    const checkCtx: CheckContext = {
      prodPages: allPageCaptures.filter((p) => p.side === "prod"),
      candPages: allPageCaptures.filter((p) => p.side === "cand"),
      prodFlows: allFlowCaptures.filter((f) => f.side === "prod"),
      candFlows: allFlowCaptures.filter((f) => f.side === "cand"),
      rc,
      ignore,
      outDir: paths.runDir,
      viewports,
    };
    const checks = await runAllChecks(checkCtx);
    spinner.succeed(`Checks concluídos (${checks.length})`);

    const allIssues = checks.flatMap((c) => c.issues);

    spinner.start(
      isLlmAvailable() ? "Agregando issues via LLM (Sonnet 4.6)…" : "Agregando issues (modo offline)…",
    );
    const topIssues = await aggregateIssues({
      runId,
      prodUrl: opts.prod,
      candUrl: opts.cand,
      viewports,
      flows,
      checks,
    });
    spinner.succeed(`${topIssues.length} issue(s) priorizada(s)`);

    const verdict = computeVerdict(checks, allIssues);
    let baselineSection: Run["baseline"] | undefined;
    if (opts.baseline) {
      try {
        const bl = loadBaseline(opts.baseline);
        const delta = compareToBaseline(
          {
            id: runId,
            issues: allIssues,
          } as unknown as Run,
          bl,
        );
        baselineSection = {
          name: opts.baseline,
          delta: {
            resolved: bl.issues.filter((i) => delta.resolved.includes(i.id)),
            new: allIssues.filter((i) => delta.new.includes(i.id)),
            regressions: allIssues.filter((i) => delta.regressions.includes(i.id)),
          },
        };
      } catch (err) {
        spinner.warn(`Baseline "${opts.baseline}" não carregou: ${(err as Error).message}`);
      }
    }

    const run: Run = {
      schemaVersion: "0.1",
      id: runId,
      timestamp,
      prodUrl: opts.prod,
      candUrl: opts.cand,
      flows,
      viewports,
      cep: rc.cep,
      durationMs: Date.now() - startedAt,
      verdict,
      topIssues,
      issues: allIssues,
      checks,
      flowCaptures: allFlowCaptures,
      baseline: baselineSection,
    };

    writeRunReportJson(paths.runDir, run);
    const html = renderHtmlReport(run, paths.runDir);
    writeRunReportHtml(paths.runDir, html);

    printSummary(run, paths.reportHtml);

    if (opts.open) {
      await open(paths.reportHtml).catch(() => undefined);
    }

    if (opts.ci) {
      const blocking = allIssues.filter((i) => failOn.includes(i.severity));
      if (blocking.length > 0) {
        console.log(
          chalk.red(`\n  ✖ ${blocking.length} issue(s) bloqueante(s) [${failOn.join(", ")}] — exit 1`),
        );
        return 1;
      }
    }
    return 0;
  } catch (err) {
    spinner.fail(`Erro: ${(err as Error).message}`);
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

  const status =
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

async function fetchHomeHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function printSummary(run: Run, htmlPath: string): void {
  const { verdict } = run;
  const emoji = verdict.status === "pass" ? chalk.green("✔") : verdict.status === "warn" ? chalk.yellow("⚠") : chalk.red("✖");
  const score = verdict.status === "pass" ? chalk.green(verdict.score) : verdict.status === "warn" ? chalk.yellow(verdict.score) : chalk.red(verdict.score);

  console.log("");
  console.log(`  ${emoji}  parity ${verdict.status.toUpperCase()} · score ${score}/100`);
  console.log(`     checks: ${chalk.green(verdict.checksPassed)} pass · ${chalk.red(verdict.checksFailed)} fail · ${chalk.dim(`${verdict.checksSkipped} skipped`)}`);
  console.log(
    `     issues: ${chalk.red(verdict.critical)} critical · ${chalk.yellow(verdict.high)} high · ${verdict.medium} medium · ${chalk.dim(`${verdict.low} low`)}`,
  );
  if (run.topIssues.length > 0) {
    console.log("");
    console.log(chalk.bold("  Top issues:"));
    for (const i of run.topIssues.slice(0, 5)) {
      const sev = i.severity === "critical" ? chalk.red(`[${i.severity}]`) : i.severity === "high" ? chalk.yellow(`[${i.severity}]`) : chalk.dim(`[${i.severity}]`);
      console.log(`     ${sev} ${i.summary}`);
    }
  }
  console.log("");
  console.log(chalk.dim(`  → ${htmlPath}`));
  console.log("");
}
