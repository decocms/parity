import { writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Browser } from "playwright";
import { launchBrowser, newContext, stopTracing } from "../engine/browser.ts";
import { installVitalsCollector } from "../engine/collect.ts";
import { runFlow } from "../engine/flows.ts";
import { loadParityIgnore, loadParityRc } from "../ignore/parser.ts";
import { detectPlatform, type Platform } from "../learned/platform.ts";
import { loadLearned } from "../learned/repo.ts";
import { isLlmAvailable, providerLabel } from "../llm/client.ts";
import { discoverSelectorsFromUrl } from "../llm/discover-selectors.ts";
import {
  createRunDir,
  newRunId,
  writeRunReportHtml,
  writeRunReportJson,
} from "../storage/fs.ts";
import type {
  FlowCapture,
  FlowName,
  Side,
  StepCapture,
  Verdict,
  Viewport,
} from "../types/schema.ts";

export interface JourneyOptions {
  prod: string;
  cand: string;
  viewports: string;
  cep: string;
  output: string;
  /** Save a full report.html / report.json in addition to the slim journey output. Default true */
  report?: boolean;
  /** Emit JUnit XML for CI consumption */
  junit?: string;
  /** Emit GitHub Actions annotation lines (::error::, ::group::) */
  github?: boolean;
  /** Emit a single-line JSON status object to stdout (and skip the table) */
  json?: boolean;
  /** Disable LLM auto-discover (uses learned + defaults only) */
  autoSelectors?: boolean;
}

const STEP_LABELS: Record<string, string> = {
  "visit-home": "1. visit-home",
  "navigate-plp": "2. navigate-plp",
  "enter-pdp": "3. enter-pdp",
  "shipping-calc-pdp": "4. shipping-calc-pdp",
  "add-to-cart": "5. add-to-cart",
  "open-minicart": "6. open-minicart",
  "shipping-calc-cart": "7. shipping-calc-cart",
  "go-checkout": "8. go-checkout",
};

const CRITICAL_STEPS = new Set([
  "visit-home",
  "navigate-plp",
  "enter-pdp",
  "add-to-cart",
  "open-minicart",
  "go-checkout",
]);

interface StepRow {
  name: string;
  viewport: Viewport;
  prod: StepCapture | undefined;
  cand: StepCapture | undefined;
}

interface JourneyFailure {
  viewport: Viewport;
  step: string;
  reason: string;
  critical: boolean;
}

export async function journeyCommand(opts: JourneyOptions): Promise<number> {
  const viewports = opts.viewports
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Viewport => s === "mobile" || s === "desktop");
  if (viewports.length === 0) {
    console.error(chalk.red("Nenhum viewport válido (use mobile,desktop)"));
    return 2;
  }

  const rc = loadParityRc();
  rc.cep = opts.cep || rc.cep;
  const ignore = loadParityIgnore();
  void ignore; // not needed for journey

  const learned = loadLearned();
  const runId = newRunId();
  const paths = createRunDir(opts.output, runId);

  if (!opts.json) {
    console.log(chalk.bold(`\n  parity journey ${runId}`));
    console.log(chalk.dim(`  prod: ${opts.prod}`));
    console.log(chalk.dim(`  cand: ${opts.cand}`));
    console.log(chalk.dim(`  viewports: ${viewports.join(", ")} · CEP: ${rc.cep}`));
    if (isLlmAvailable()) console.log(chalk.dim(`  llm: ${providerLabel()}`));
    console.log("");
  }

  // Platform + optional LLM selector discovery (light path; reuses cache)
  let platform: Platform = "custom";
  try {
    const homeRes = await fetch(opts.prod, {
      headers: { "User-Agent": "Mozilla/5.0 parity-cli" },
    });
    if (homeRes.ok) {
      const html = await homeRes.text();
      platform = detectPlatform({ url: opts.prod, html });
      if (opts.autoSelectors !== false && isLlmAvailable()) {
        const discovered = await discoverSelectorsFromUrl(opts.prod, html, {});
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
        }
      }
    }
  } catch {
    /* tolerated: discovery skipped if fetch fails */
  }

  const spinner = opts.json ? null : ora("Launching browser…").start();
  let browser: Browser | null = null;
  const flowCaptures: FlowCapture[] = [];

  try {
    browser = await launchBrowser({ headless: true });

    for (const viewport of viewports) {
      for (const side of ["prod", "cand"] as Side[]) {
        if (spinner) spinner.text = `[${viewport}/${side}] purchase-journey…`;
        const baseUrl = side === "prod" ? opts.prod : opts.cand;
        const tracePath = join(paths.tracesDir, `${viewport}-${side}.zip`);
        const ctx = await newContext(browser, {
          viewport,
          tracesDir: paths.tracesDir,
          cohortCookieValue: "control",
        });
        await installVitalsCollector(ctx);
        const cap = await runFlow("purchase-journey", {
          baseUrl,
          side,
          viewport,
          rc,
          ctx,
          outDir: paths.screenshotsDir,
          learned,
          platform,
          recoveryBudget: 3,
        });
        flowCaptures.push(cap);
        await stopTracing(ctx, tracePath).catch(() => undefined);
        await ctx.close();
      }
    }

    spinner?.succeed("Jornada coletada");

    // Build per-viewport step rows comparing prod vs cand
    const rows: StepRow[] = buildRows(flowCaptures, viewports);
    const failures = collectFailures(rows);

    // Save raw flow captures as JSON for traceability
    writeRunReportJson(paths.runDir, buildJourneyRun(opts, runId, flowCaptures, failures));

    if (opts.report !== false) {
      writeRunReportHtml(paths.runDir, buildJourneyHtml(opts, flowCaptures, rows, failures));
    }

    // Output: JSON one-shot OR human-readable table
    if (opts.json) {
      console.log(JSON.stringify(buildJsonStatus(runId, rows, failures, paths.reportHtml)));
    } else {
      printTable(viewports, rows);
      printSummary(rows, failures, paths.reportHtml);
    }

    if (opts.github) emitGithubAnnotations(failures);

    if (opts.junit) {
      writeFileSync(opts.junit, buildJUnit(rows, failures), "utf8");
      if (!opts.json) console.log(chalk.dim(`  → JUnit XML: ${opts.junit}`));
    }

    return failures.some((f) => f.critical) ? 1 : 0;
  } catch (err) {
    spinner?.fail(`Erro: ${(err as Error).message}`);
    console.error(err);
    return 2;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

function buildRows(flows: FlowCapture[], viewports: Viewport[]): StepRow[] {
  const rows: StepRow[] = [];
  for (const viewport of viewports) {
    const prodFlow = flows.find((f) => f.viewport === viewport && f.side === "prod");
    const candFlow = flows.find((f) => f.viewport === viewport && f.side === "cand");
    const stepNames = new Set<string>();
    for (const s of prodFlow?.steps ?? []) stepNames.add(s.name);
    for (const s of candFlow?.steps ?? []) stepNames.add(s.name);
    // Maintain known order
    const ordered = Object.keys(STEP_LABELS).filter((k) => stepNames.has(k));
    for (const name of stepNames) if (!ordered.includes(name)) ordered.push(name);
    for (const name of ordered) {
      rows.push({
        name,
        viewport,
        prod: prodFlow?.steps?.find((s) => s.name === name),
        cand: candFlow?.steps?.find((s) => s.name === name),
      });
    }
  }
  return rows;
}

function collectFailures(rows: StepRow[]): JourneyFailure[] {
  const out: JourneyFailure[] = [];
  for (const r of rows) {
    const prodOk = !r.prod || r.prod.status === "ok";
    const candOk = !r.cand || r.cand.status === "ok";
    if (prodOk && !candOk) {
      out.push({
        viewport: r.viewport,
        step: r.name,
        reason: r.cand?.note ?? `cand status = ${r.cand?.status ?? "missing"}`,
        critical: CRITICAL_STEPS.has(r.name),
      });
    } else if (r.prod?.status === "ok" && r.cand?.status === "skipped") {
      out.push({
        viewport: r.viewport,
        step: r.name,
        reason: `cand pulou (${r.cand.note ?? "elemento não encontrado"})`,
        critical: CRITICAL_STEPS.has(r.name),
      });
    }
  }
  return out;
}

function printTable(viewports: Viewport[], rows: StepRow[]): void {
  console.log("");
  for (const viewport of viewports) {
    console.log(chalk.bold(`  [${viewport}]`));
    const vrows = rows.filter((r) => r.viewport === viewport);
    for (const r of vrows) {
      const label = STEP_LABELS[r.name] ?? r.name;
      const p = statusGlyph(r.prod?.status);
      const c = statusGlyph(r.cand?.status);
      const status = r.prod?.status === "ok" && r.cand?.status !== "ok" ? chalk.red("FAILED") : "";
      const note =
        r.cand?.status === "failed" || r.cand?.status === "skipped"
          ? chalk.dim(`(${r.cand?.note ?? r.cand?.status})`)
          : "";
      console.log(`    ${label.padEnd(24)}  prod ${p}   cand ${c}   ${status} ${note}`);
    }
    console.log("");
  }
}

function statusGlyph(status: StepCapture["status"] | undefined): string {
  if (!status) return chalk.dim("—");
  if (status === "ok") return chalk.green("✓");
  if (status === "skipped") return chalk.yellow("○");
  return chalk.red("✗");
}

function printSummary(rows: StepRow[], failures: JourneyFailure[], htmlPath: string): void {
  const byViewport = new Map<Viewport, { passed: number; total: number }>();
  for (const r of rows) {
    const v = byViewport.get(r.viewport) ?? { passed: 0, total: 0 };
    v.total++;
    if (r.cand?.status === "ok") v.passed++;
    byViewport.set(r.viewport, v);
  }
  console.log(chalk.bold("  Summary:"));
  for (const [vp, { passed, total }] of byViewport) {
    const stat = passed === total ? chalk.green("✓") : chalk.yellow(`${passed}/${total}`);
    console.log(`    ${vp.padEnd(8)} ${stat} steps em cand`);
  }
  if (failures.length > 0) {
    const crit = failures.filter((f) => f.critical).length;
    console.log("");
    console.log(chalk.red(`  ✗ ${failures.length} step(s) divergent(es) (${crit} crítico)`));
    for (const f of failures) {
      const tag = f.critical ? chalk.red("[critical]") : chalk.yellow("[warn]");
      console.log(`    ${tag} [${f.viewport}] ${f.step}: ${f.reason}`);
    }
  } else {
    console.log("");
    console.log(chalk.green("  ✓ jornada completa em cand"));
  }
  console.log("");
  console.log(chalk.dim(`  → ${htmlPath}`));
  console.log("");
}

function emitGithubAnnotations(failures: JourneyFailure[]): void {
  for (const f of failures) {
    const level = f.critical ? "error" : "warning";
    const title = `Journey step '${f.step}' failed on ${f.viewport}`;
    const msg = f.reason;
    // GitHub Actions annotation
    console.log(`::${level} title=${title}::${msg}`);
  }
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildJUnit(rows: StepRow[], failures: JourneyFailure[]): string {
  const tests = rows.length;
  const failureSet = new Set(failures.map((f) => `${f.viewport}:${f.step}`));
  const testcases = rows
    .map((r) => {
      const isFail = failureSet.has(`${r.viewport}:${r.name}`);
      const failure = failures.find((f) => f.viewport === r.viewport && f.step === r.name);
      const inner = isFail
        ? `<failure type="${escXml(r.name)}" message="${escXml(failure?.reason ?? "step failed")}"/>`
        : "";
      const duration = ((r.prod?.durationMs ?? 0) + (r.cand?.durationMs ?? 0)) / 1000;
      return `<testcase classname="parity.journey.${escXml(r.viewport)}" name="${escXml(r.name)}" time="${duration.toFixed(3)}">${inner}</testcase>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="parity.journey" tests="${tests}" failures="${failures.length}" time="0">
${testcases}
</testsuite>`;
}

function buildJsonStatus(
  runId: string,
  rows: StepRow[],
  failures: JourneyFailure[],
  htmlPath: string,
): Record<string, unknown> {
  return {
    runId,
    htmlReport: htmlPath,
    status: failures.some((f) => f.critical) ? "fail" : failures.length > 0 ? "warn" : "pass",
    totalSteps: rows.length,
    failures: failures.map((f) => ({
      viewport: f.viewport,
      step: f.step,
      reason: f.reason,
      critical: f.critical,
    })),
  };
}

function buildJourneyRun(
  opts: JourneyOptions,
  runId: string,
  flowCaptures: FlowCapture[],
  failures: JourneyFailure[],
) {
  const totalDuration = flowCaptures.reduce((a, b) => a + b.totalDurationMs, 0);
  const critical = failures.filter((f) => f.critical).length;
  const others = failures.length - critical;
  const verdict: Verdict = {
    status: critical > 0 ? "fail" : failures.length > 0 ? "warn" : "pass",
    score: Math.max(0, 100 - critical * 20 - others * 8),
    critical,
    high: others,
    medium: 0,
    low: 0,
    checksRun: 1,
    checksPassed: failures.length === 0 ? 1 : 0,
    checksFailed: critical > 0 ? 1 : 0,
    checksSkipped: 0,
  };
  return {
    schemaVersion: "0.1" as const,
    id: runId,
    timestamp: new Date().toISOString(),
    prodUrl: opts.prod,
    candUrl: opts.cand,
    flows: ["purchase-journey" as FlowName],
    viewports: opts.viewports.split(",") as Viewport[],
    cep: opts.cep,
    durationMs: totalDuration,
    verdict,
    topIssues: [],
    issues: [],
    checks: [],
    flowCaptures,
  };
}

function buildJourneyHtml(
  opts: JourneyOptions,
  flowCaptures: FlowCapture[],
  rows: StepRow[],
  failures: JourneyFailure[],
): string {
  // Light HTML, no full report dependencies — just step matrix
  const failed = failures.length;
  const headerStatus =
    failures.some((f) => f.critical)
      ? '<span style="color:#e5484d">FAIL</span>'
      : failed > 0
        ? '<span style="color:#f5a623">WARN</span>'
        : '<span style="color:#2ec27e">PASS</span>';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>parity journey</title>
<style>
body{margin:0;font-family:-apple-system,sans-serif;background:#0b0e14;color:#e6e8eb;padding:24px}
h1{font-size:18px;margin:0 0 8px 0}
.urls{color:#8a93a6;font-size:13px;margin-bottom:24px}
table{border-collapse:collapse;width:100%;margin-bottom:24px}
td,th{padding:8px 12px;border-bottom:1px solid #232a37;font-size:13px;text-align:left}
th{color:#8a93a6;font-weight:500}
.ok{color:#2ec27e}.fail{color:#e5484d}.skip{color:#f5a623}.missing{color:#8a93a6}
.reason{font-size:12px;color:#8a93a6}
</style></head><body>
<h1>parity journey · ${headerStatus}</h1>
<div class="urls">prod ${escapeHtml(opts.prod)} · cand ${escapeHtml(opts.cand)} · CEP ${escapeHtml(opts.cep)}</div>
${[...new Set(rows.map((r) => r.viewport))]
  .map((vp) => {
    const vrows = rows.filter((r) => r.viewport === vp);
    return `<h2 style="font-size:14px;margin:24px 0 8px 0;text-transform:uppercase">${vp}</h2>
<table><thead><tr><th>Step</th><th>prod</th><th>cand</th><th>Δ</th><th>Note</th></tr></thead>
<tbody>${vrows
      .map((r) => {
        const noteCand = r.cand?.note ? `<span class="reason">${escapeHtml(r.cand.note)}</span>` : "";
        const isFail = r.prod?.status === "ok" && r.cand?.status !== "ok";
        const delta = isFail ? '<span class="fail">FAIL</span>' : "";
        return `<tr>
        <td>${escapeHtml(STEP_LABELS[r.name] ?? r.name)}</td>
        <td class="${cssClass(r.prod?.status)}">${glyph(r.prod?.status)}</td>
        <td class="${cssClass(r.cand?.status)}">${glyph(r.cand?.status)}</td>
        <td>${delta}</td>
        <td>${noteCand}</td>
      </tr>`;
      })
      .join("")}</tbody></table>`;
  })
  .join("")}
<p class="urls">${flowCaptures.length} flow capture(s) · ${rows.length} step(s) compared</p>
</body></html>`;
}

function glyph(s: StepCapture["status"] | undefined): string {
  if (!s) return "—";
  if (s === "ok") return "✓";
  if (s === "skipped") return "○";
  return "✗";
}
function cssClass(s: StepCapture["status"] | undefined): string {
  if (!s) return "missing";
  if (s === "ok") return "ok";
  if (s === "skipped") return "skip";
  return "fail";
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
