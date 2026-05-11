import { writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Browser } from "playwright";
import { launchBrowser, newContext, stopTracing } from "../engine/browser.ts";
import { installVitalsCollector } from "../engine/collect.ts";
import { runFlow, type StepProgressEvent } from "../engine/flows.ts";
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

  const stepLabel = (name: string) =>
    ({
      "visit-home": "Testing home",
      "navigate-plp": "Entering category (PLP)",
      "enter-pdp": "Entering product (PDP)",
      "shipping-calc-pdp": "Testing shipping calc on PDP",
      "add-to-cart": "Add to cart",
      "open-minicart": "Opening minicart",
      "shipping-calc-cart": "Testing shipping calc on cart",
      "go-checkout": "Going to checkout",
    })[name] ?? name;

  const onStepFor = (viewport: Viewport, side: Side) => (event: StepProgressEvent) => {
    if (opts.json) return; // keep stdout machine-readable
    const sideTag = side === "prod" ? chalk.cyan("prod") : chalk.magenta("cand");
    const prefix = `  ${chalk.dim(`[${viewport}/`)}${sideTag}${chalk.dim("]")}`;
    if (event.phase === "start") {
      console.log(`${prefix} ${chalk.dim(`${event.index}/${event.total}`)} ▶ ${chalk.bold(stepLabel(event.name))}`);
    } else {
      const glyph =
        event.status === "ok"
          ? chalk.green("✓")
          : event.status === "skipped"
            ? chalk.yellow("○")
            : chalk.red("✗");
      const noteText = event.note ? chalk.dim(` (${event.note})`) : "";
      const time = chalk.dim(`${(event.durationMs / 1000).toFixed(1)}s`);
      console.log(
        `${prefix} ${chalk.dim(`${event.index}/${event.total}`)} ${glyph} ${stepLabel(event.name)} ${time}${noteText}`,
      );
    }
  };

  async function runOneSide(
    browserInstance: Browser,
    viewport: Viewport,
    side: Side,
  ): Promise<FlowCapture> {
    const baseUrl = side === "prod" ? opts.prod : opts.cand;
    const tracePath = join(paths.tracesDir, `${viewport}-${side}.zip`);
    const ctx = await newContext(browserInstance, {
      viewport,
      tracesDir: paths.tracesDir,
      cohortCookieValue: "control",
    });
    await installVitalsCollector(ctx);
    try {
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
        onStep: onStepFor(viewport, side),
      });
      return cap;
    } finally {
      await stopTracing(ctx, tracePath).catch(() => undefined);
      await ctx.close();
    }
  }

  try {
    browser = await launchBrowser({ headless: true });
    spinner?.succeed("Browser pronto");

    for (const viewport of viewports) {
      if (!opts.json) console.log(chalk.bold(`\n  ── ${viewport} ─────────────────────────────────────────────`));
      // Run prod and cand in PARALLEL (cuts wall time ~2x)
      const [prodCap, candCap] = await Promise.all([
        runOneSide(browser, viewport, "prod"),
        runOneSide(browser, viewport, "cand"),
      ]);
      flowCaptures.push(prodCap, candCap);
    }
    if (!opts.json) console.log("");

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
  const failed = failures.length;
  const headerStatus =
    failures.some((f) => f.critical)
      ? '<span class="status fail">FAIL</span>'
      : failed > 0
        ? '<span class="status warn">WARN</span>'
        : '<span class="status pass">PASS</span>';
  void flowCaptures;

  const viewports = [...new Set(rows.map((r) => r.viewport))];

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>parity journey · ${headerStatus.replace(/<[^>]+>/g, "")}</title>
<style>
:root{--bg:#0b0e14;--card:#131720;--elev:#1a1f2b;--border:#232a37;--fg:#e6e8eb;--muted:#8a93a6;--green:#2ec27e;--yellow:#f5a623;--red:#e5484d;--prod:#36b3ff;--cand:#b86eff}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:var(--bg);color:var(--fg);padding:24px;line-height:1.5}
h1{font-size:20px;margin:0 0 8px 0;display:flex;align-items:center;gap:12px}
.urls{color:var(--muted);font-size:13px;margin-bottom:24px;word-break:break-all}
.status{font-size:13px;font-weight:700;padding:4px 10px;border-radius:6px;text-transform:uppercase;letter-spacing:0.05em}
.status.pass{background:rgba(46,194,126,0.15);color:var(--green)}
.status.warn{background:rgba(245,166,35,0.15);color:var(--yellow)}
.status.fail{background:rgba(229,72,77,0.15);color:var(--red)}
h2{font-size:13px;font-weight:600;margin:32px 0 12px 0;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted)}
.step{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:14px}
.step-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.step-num{font-size:11px;color:var(--muted);font-weight:600;background:var(--elev);padding:2px 8px;border-radius:4px}
.step-name{font-size:15px;font-weight:600;flex:1}
.step-state{display:flex;gap:8px}
.state-pill{font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;text-transform:uppercase;letter-spacing:0.04em}
.state-pill.ok{background:rgba(46,194,126,0.15);color:var(--green)}
.state-pill.fail{background:rgba(229,72,77,0.15);color:var(--red)}
.state-pill.skipped{background:rgba(245,166,35,0.15);color:var(--yellow)}
.state-pill.missing{background:rgba(138,147,166,0.15);color:var(--muted)}
.step-meta{font-size:12px;color:var(--muted);margin-top:8px;display:flex;flex-direction:column;gap:4px}
.step-meta code{font-size:11px;color:var(--fg);background:var(--elev);padding:1px 6px;border-radius:3px}
.step-action{font-size:13px;color:var(--fg);background:var(--elev);padding:8px 12px;border-radius:6px;margin-top:10px;border-left:3px solid var(--prod)}
.step-note{font-size:12px;color:var(--yellow);margin-top:6px}
.step-before{margin-top:12px;border-top:1px solid var(--border);padding-top:10px}
.step-before summary{cursor:pointer;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;font-weight:600;list-style:none;padding:4px 0}
.step-before summary::-webkit-details-marker{display:none}
.step-before summary::before{content:"▶";color:var(--muted);font-size:9px;margin-right:8px;display:inline-block;transition:transform .15s}
.step-before[open] summary::before{transform:rotate(90deg)}
.shots-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;font-weight:600;margin-top:12px;margin-bottom:6px}
.traces-note{font-size:11px;color:var(--muted);background:var(--elev);padding:8px 12px;border-radius:6px;margin-bottom:12px}
.traces-note code{color:var(--fg);background:var(--bg);padding:1px 6px;border-radius:3px}
.traces-note a{color:var(--prod)}
.shots{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}
.shot{position:relative;background:var(--elev);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.shot .label{position:absolute;top:8px;left:8px;font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.05em;z-index:1;color:white;backdrop-filter:blur(8px)}
.shot.prod .label{background:var(--prod)}
.shot.cand .label{background:var(--cand)}
.shot img{display:block;width:100%;height:auto;cursor:zoom-in}
.shot.missing{display:flex;align-items:center;justify-content:center;height:200px;color:var(--muted);font-size:12px;font-style:italic}
.summary{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-top:24px;font-size:13px}
.summary .row{display:flex;justify-content:space-between;padding:4px 0}
.fail-list{margin-top:12px}
.fail-list li{margin-bottom:6px;color:var(--fg)}
.legend{font-size:11px;color:var(--muted);margin-bottom:16px}
.legend .swatch{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;margin-right:4px}
.swatch.prod{background:var(--prod)}
.swatch.cand{background:var(--cand)}
/* zoom modal */
.modal{position:fixed;inset:0;background:rgba(0,0,0,0.9);display:none;align-items:flex-start;justify-content:center;padding:24px;z-index:100;cursor:zoom-out;overflow:auto}
.modal.open{display:flex}
.modal img{max-width:100%;height:auto;border-radius:8px}
</style></head><body>
<h1>parity journey ${headerStatus}</h1>
<div class="urls">
  <span class="legend"><span class="swatch prod"></span>prod (Fresh): ${escapeHtml(opts.prod)}</span><br/>
  <span class="legend"><span class="swatch cand"></span>cand (TanStack): ${escapeHtml(opts.cand)}</span><br/>
  <span style="color:var(--muted);font-size:12px">CEP: ${escapeHtml(opts.cep)}</span>
</div>
${viewports
  .map((vp) => {
    const vrows = rows.filter((r) => r.viewport === vp);
    const tracesNote = `<div class="traces-note">
      Playwright traces (debug profundo): abra <code>traces/${vp}-prod.zip</code> ou <code>traces/${vp}-cand.zip</code> em <a href="https://trace.playwright.dev" target="_blank" rel="noreferrer">trace.playwright.dev</a> (arrasta o arquivo na página)
    </div>`;
    return `<h2>${vp}</h2>${tracesNote}${vrows.map((r) => renderStepCard(r)).join("")}`;
  })
  .join("")}
${renderSummaryBlock(rows, failures)}
<div id="zoom" class="modal" onclick="this.classList.remove('open')"><img id="zoomImg" alt=""/></div>
<script>
document.querySelectorAll('.shot img').forEach(function(img){
  img.addEventListener('click', function(){
    var modal = document.getElementById('zoom');
    var modalImg = document.getElementById('zoomImg');
    modalImg.src = img.src;
    modal.classList.add('open');
  });
});
</script>
</body></html>`;
}

function renderStepCard(r: StepRow): string {
  const label = STEP_LABELS[r.name] ?? r.name;
  const prodStatus = r.prod?.status ?? "missing";
  const candStatus = r.cand?.status ?? "missing";
  const note = r.cand?.note ?? r.prod?.note ?? "";
  const prodDur = r.prod?.durationMs ?? 0;
  const candDur = r.cand?.durationMs ?? 0;
  // Prefer cand's action description (typically same as prod's in shape, both ran the same script)
  const actionDescription = r.cand?.actionDescription ?? r.prod?.actionDescription ?? "";
  const hasBefore = !!(r.prod?.screenshotBeforePath || r.cand?.screenshotBeforePath);
  const beforeUrl = r.cand?.beforeUrl ?? r.prod?.beforeUrl;
  const afterUrl = r.cand?.url ?? r.prod?.url;

  return `<div class="step">
    <div class="step-head">
      <span class="step-num">${escapeHtml(label.split(".")[0] ?? "?")}</span>
      <span class="step-name">${escapeHtml(label.replace(/^\d+\.\s*/, ""))}</span>
      <span class="step-state">
        <span class="state-pill ${prodStatus}">prod · ${escapeHtml(prodStatus)}</span>
        <span class="state-pill ${candStatus}">cand · ${escapeHtml(candStatus)}</span>
      </span>
    </div>
    ${actionDescription ? `<div class="step-action">▶ ${escapeHtml(actionDescription)}</div>` : ""}
    <div class="step-meta">
      ${beforeUrl && afterUrl && beforeUrl !== afterUrl ? `<div>📍 <code>${escapeHtml(beforeUrl)}</code> → <code>${escapeHtml(afterUrl)}</code></div>` : afterUrl ? `<div>📍 <code>${escapeHtml(afterUrl)}</code></div>` : ""}
      <div>⏱ prod ${(prodDur / 1000).toFixed(1)}s · cand ${(candDur / 1000).toFixed(1)}s</div>
    </div>
    ${note ? `<div class="step-note">${escapeHtml(note)}</div>` : ""}
    ${hasBefore ? `<details class="step-before"><summary>Estado ANTES da ação</summary><div class="shots">${renderShot("prod", r.prod?.screenshotBeforePath, "before")}${renderShot("cand", r.cand?.screenshotBeforePath, "before")}</div></details>` : ""}
    <div class="shots-label">Estado APÓS a ação</div>
    <div class="shots">
      ${renderShot("prod", r.prod?.screenshotPath)}
      ${renderShot("cand", r.cand?.screenshotPath)}
    </div>
  </div>`;
}

function renderShot(side: "prod" | "cand", path: string | undefined, when: "before" | "after" = "after"): string {
  if (!path) {
    return `<div class="shot missing"><span class="label" style="position:static;background:var(--muted)">${side}</span>&nbsp;sem screenshot</div>`;
  }
  const rel = path.split("/screenshots/").pop();
  const src = rel ? `screenshots/${rel}` : path;
  const labelText = when === "before" ? `${side} antes` : side;
  return `<div class="shot ${side}"><span class="label">${labelText}</span><img src="${escapeHtml(src)}" alt="${labelText}" loading="lazy"/></div>`;
}

function renderSummaryBlock(rows: StepRow[], failures: JourneyFailure[]): string {
  const byVp = new Map<Viewport, { passed: number; total: number }>();
  for (const r of rows) {
    const cur = byVp.get(r.viewport) ?? { passed: 0, total: 0 };
    cur.total++;
    if (r.cand?.status === "ok") cur.passed++;
    byVp.set(r.viewport, cur);
  }
  const rowsHtml = [...byVp]
    .map(([vp, { passed, total }]) => `<div class="row"><span>${vp}</span><span>${passed}/${total} steps em cand</span></div>`)
    .join("");
  const failList = failures
    .map(
      (f) =>
        `<li>${f.critical ? '<strong style="color:var(--red)">[critical]</strong>' : '<strong style="color:var(--yellow)">[warn]</strong>'} <code>${f.viewport}</code> · <code>${f.step}</code> — ${escapeHtml(f.reason)}</li>`,
    )
    .join("");
  return `<div class="summary">
    <strong>Summary</strong>
    ${rowsHtml}
    ${failures.length > 0 ? `<ul class="fail-list">${failList}</ul>` : '<div style="color:var(--green);margin-top:8px">✓ jornada completa em cand</div>'}
  </div>`;
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
