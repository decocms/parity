import { writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Browser } from "playwright";
import { aggregateAudit, runAuditForPage } from "../audit/index.ts";
import { ALL_CHECKS, type CheckContext } from "../checks/index.ts";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { installVitalsCollector } from "../engine/collect.ts";
import { runFlow } from "../engine/flows.ts";
import { loadParityIgnore, loadParityRc } from "../ignore/parser.ts";
import { loadLearned } from "../learned/repo.ts";
import { renderAuditHtmlReport } from "../report/audit-render.ts";
import { createRunDir, newRunId } from "../storage/fs.ts";
import type {
  CheckResult,
  FlowCapture,
  FlowName,
  Issue,
  PageCapture,
  Viewport,
} from "../types/schema.ts";

export interface E2eCommandOptions {
  url: string;
  flows: string;
  viewports: string;
  cep: string;
  searchTerms?: string;
  loginEmail?: string;
  loginPassword?: string;
  output: string;
  open?: boolean;
  json?: boolean;
  failOn: string;
}

const SEVERITY_RANK: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const DEFAULT_E2E_FLOWS: FlowName[] = [
  "homepage",
  "plp",
  "pdp",
  "purchase-journey",
  "search",
  "cart-interactions",
];

/**
 * `parity e2e` — single-site functional end-to-end. Runs the full set of
 * functional flows (homepage, plp, pdp, purchase-journey, search,
 * cart-interactions, optionally login) against ONE URL, then runs ALL
 * checks in single-site / absolute mode (no prod×cand comparison).
 *
 * Designed for the "is this site functioning right?" workflow that the
 * audit command (vitals/console/network/images/seo only) can't cover.
 *
 * Internally reuses the audit machinery (capture pipeline, browser launch,
 * report renderer) plus the flow runner from the run command.
 */
export async function e2eCommand(opts: E2eCommandOptions): Promise<number> {
  const viewports = parseViewports(opts.viewports);
  if (viewports.length === 0) {
    console.error(chalk.red(`--viewports inválido: ${opts.viewports} (use mobile,desktop,tablet)`));
    return 2;
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(opts.url);
  } catch {
    console.error(chalk.red(`--url inválido: ${opts.url}`));
    return 2;
  }
  const flows = parseFlows(opts.flows);
  if (flows.length === 0) {
    console.error(chalk.red(`--flows inválido: ${opts.flows}`));
    return 2;
  }

  const rc = loadParityRc();
  rc.cep = opts.cep || rc.cep;
  if (opts.searchTerms) {
    rc.search = {
      ...(rc.search ?? {}),
      terms: opts.searchTerms
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  if (opts.loginEmail) process.env.PARITY_LOGIN_EMAIL = opts.loginEmail;
  if (opts.loginPassword) process.env.PARITY_LOGIN_PASSWORD = opts.loginPassword;
  if (flows.includes("login")) {
    rc.login = { ...(rc.login ?? { enabled: false }), enabled: true };
  }
  const ignore = loadParityIgnore();
  const learned = loadLearned();

  const failOn = (opts.failOn || "critical,high")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Issue["severity"][];

  const runId = newRunId();
  const paths = createRunDir(opts.output, runId);
  const startedAt = Date.now();

  if (!opts.json) {
    console.log(chalk.bold(`\n  parity e2e ${runId}`));
    console.log(chalk.dim(`  url:       ${opts.url}`));
    console.log(chalk.dim(`  flows:     ${flows.join(", ")}`));
    console.log(chalk.dim(`  viewports: ${viewports.join(", ")}`));
    console.log(chalk.dim(`  cep:       ${rc.cep}\n`));
  }

  const spinner = opts.json ? null : ora("Lançando browser…").start();
  let browser: Browser | null = null;
  const allFlows: FlowCapture[] = [];
  const allPages: PageCapture[] = [];

  try {
    browser = await launchBrowser({ headless: true });
    for (const viewport of viewports) {
      const ctx = await newContext(browser, { viewport });
      await installVitalsCollector(ctx);
      for (const flow of flows) {
        if (spinner) spinner.text = `[${viewport}] flow "${flow}"…`;
        try {
          const cap = await runFlow(flow, {
            baseUrl: opts.url,
            side: "cand", // single-site convention: everything goes through cand slot
            viewport,
            rc,
            ctx,
            outDir: paths.screenshotsDir,
            runId,
            learned,
            recoveryBudget: 2,
          });
          allFlows.push(cap);
          for (const p of cap.pages) allPages.push(p);
        } catch (err) {
          if (spinner) spinner.warn(`flow ${flow} (${viewport}) erro: ${(err as Error).message}`);
        }
      }
      await ctx.close().catch(() => undefined);
    }
    if (spinner)
      spinner.succeed(`${allFlows.length} flow capture(s), ${allPages.length} página(s)`);
  } finally {
    await browser?.close().catch(() => undefined);
  }

  if (allPages.length === 0) {
    console.error(chalk.red("\n  ✖ nenhuma captura completada"));
    return 2;
  }

  // ─── Run absolute audit checks per page (vitals/console/network/images/seo) ───
  const auditSpinner = opts.json
    ? null
    : ora("Audit checks (vitals/console/network/images/seo)…").start();
  const auditResults = allPages.map(runAuditForPage);
  const audit = aggregateAudit(auditResults);
  if (auditSpinner) auditSpinner.succeed(`${audit.totals.issues} audit issue(s)`);

  // ─── Run new flow-aware checks in single-site mode ───
  const checkSpinner = opts.json
    ? null
    : ora("Flow checks (search/cart/PDP/404/CLS/footer/login)…").start();
  const checkCtx: CheckContext = {
    prodPages: [],
    candPages: allPages,
    prodFlows: [],
    candFlows: allFlows,
    rc,
    ignore,
    outDir: paths.screenshotsDir,
    viewports,
  };
  const flowCheckResults: CheckResult[] = [];
  for (const check of ALL_CHECKS) {
    try {
      const r = await check(checkCtx);
      flowCheckResults.push(r);
    } catch (err) {
      flowCheckResults.push({
        name: check.name || "anonymous-check",
        status: "fail",
        severity: "medium",
        durationMs: 0,
        summary: `check threw: ${(err as Error).message}`,
        issues: [],
      });
    }
  }
  const flowIssues = flowCheckResults.flatMap((r) => r.issues);
  if (checkSpinner)
    checkSpinner.succeed(`${flowCheckResults.length} check(s), ${flowIssues.length} flow issue(s)`);

  // ─── Aggregate + write report ───
  const durationMs = Date.now() - startedAt;
  const allIssues = [...audit.allIssues, ...flowIssues].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const enriched = {
    ...audit,
    allIssues,
    totals: {
      ...audit.totals,
      issues: allIssues.length,
      critical: allIssues.filter((i) => i.severity === "critical").length,
      high: allIssues.filter((i) => i.severity === "high").length,
      medium: allIssues.filter((i) => i.severity === "medium").length,
      low: allIssues.filter((i) => i.severity === "low").length,
    },
  };

  const html = renderAuditHtmlReport({
    result: enriched,
    url: opts.url,
    generatedAt: new Date().toISOString(),
    durationMs,
  });
  writeFileSync(paths.reportHtml, html, "utf8");
  writeFileSync(
    paths.reportJson,
    `${JSON.stringify(
      {
        runId,
        mode: "e2e",
        url: opts.url,
        flows,
        viewports,
        cep: rc.cep,
        timestamp: new Date(startedAt).toISOString(),
        durationMs,
        ...enriched,
        flowCaptures: allFlows,
        flowChecks: flowCheckResults,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (opts.json) {
    console.log(
      JSON.stringify({
        runId,
        url: opts.url,
        flows,
        viewports,
        durationMs,
        totals: enriched.totals,
        reportHtml: paths.reportHtml,
        reportJson: paths.reportJson,
      }),
    );
  } else {
    printSummary(enriched, paths.reportHtml);
  }

  const worstSev =
    enriched.totals.critical > 0
      ? "critical"
      : enriched.totals.high > 0
        ? "high"
        : enriched.totals.medium > 0
          ? "medium"
          : enriched.totals.low > 0
            ? "low"
            : null;
  if (opts.open) await openReport(paths.reportHtml);
  if (worstSev && failOn.includes(worstSev as Issue["severity"])) return 1;
  return 0;
}

function parseViewports(raw: string): Viewport[] {
  const list = (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.filter((v): v is Viewport => v === "mobile" || v === "desktop" || v === "tablet");
}

function parseFlows(raw: string | undefined): FlowName[] {
  if (!raw || raw.trim().length === 0) return DEFAULT_E2E_FLOWS;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as FlowName[];
  const valid: FlowName[] = [
    "homepage",
    "plp",
    "pdp",
    "purchase-journey",
    "search",
    "cart-interactions",
    "login",
  ];
  return list.filter((f) => valid.includes(f));
}

function printSummary(result: ReturnType<typeof aggregateAudit>, reportPath: string): void {
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
}

async function openReport(path: string): Promise<void> {
  try {
    const { default: open } = await import("open");
    await open(path);
  } catch {
    // open package missing; non-fatal.
  }
}
