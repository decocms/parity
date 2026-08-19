import { writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import {
  type BenchmarkReport,
  type SideBenchmark,
  resolveTargetPaths,
  runSideBenchmark,
} from "../engine/benchmark.ts";
import { launchBrowser, userAgentFor } from "../engine/browser.ts";
import { loadParityRc } from "../ignore/parser.ts";
import { type Platform, detectPlatform } from "../learned/platform.ts";
import { loadLearned } from "../learned/repo.ts";
import { isLlmAvailable, providerLabel } from "../llm/client.ts";
import { discoverSelectorsFromUrl, mergeDiscoveredSelectors } from "../llm/discover-selectors.ts";
import { renderBenchmarkHtml } from "../report/benchmark-html.ts";
import { createRunDir, newRunId } from "../storage/fs.ts";
import type { Side, Viewport } from "../types/schema.ts";

export interface BenchmarkOptions {
  prod: string;
  cand: string;
  viewports: string;
  warmupRuns: string | number;
  measuredRuns: string | number;
  paginations: string | number;
  cep: string;
  output: string;
  /** Pin the PLP path (skip auto-discovery, e.g. a clothing category). */
  plp?: string;
  /** Skip the Lighthouse web-vitals pass. */
  vitals?: boolean;
  /** Disable LLM auto-discover (defaults + learned only). */
  autoSelectors?: boolean;
  /** Default HTML report language (the PT/EN toggle can switch live). */
  lang?: string;
  open?: boolean;
}

function num(v: string | number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function benchmarkCommand(opts: BenchmarkOptions): Promise<number> {
  const viewports = opts.viewports
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Viewport => s === "mobile" || s === "desktop");
  if (viewports.length === 0) {
    console.error(chalk.red("Nenhum viewport válido (use mobile,desktop)"));
    return 2;
  }

  const warmupRuns = num(opts.warmupRuns, 2);
  const measuredRuns = Math.max(1, num(opts.measuredRuns, 3));
  const paginations = num(opts.paginations, 3);
  const runVitals = opts.vitals !== false;
  const lang = opts.lang === "en" ? "en" : "pt";

  const rc = loadParityRc();
  rc.cep = opts.cep || rc.cep;
  if (opts.plp) rc.plpUrlHint = opts.plp;
  const learned = loadLearned();
  const runId = newRunId();
  const paths = createRunDir(opts.output, runId);

  console.log(chalk.bold(`\n  parity benchmark ${runId}`));
  console.log(chalk.dim(`  prod (Fresh):   ${opts.prod}`));
  console.log(chalk.dim(`  cand (TanStack): ${opts.cand}`));
  console.log(
    chalk.dim(
      `  viewports: ${viewports.join(", ")} · warmup: ${warmupRuns} · medido: ${measuredRuns} · paginações: ${paginations} · vitals: ${runVitals ? "sim" : "não"}`,
    ),
  );
  if (isLlmAvailable()) console.log(chalk.dim(`  llm: ${providerLabel()}`));
  console.log("");

  // Platform detection + optional LLM selector discovery on the PROD home
  // (source of truth). Tolerated to fail — degrades to defaults + learned.
  let platform: Platform = "custom";
  try {
    const res = await fetch(opts.prod, {
      headers: { "User-Agent": userAgentFor(viewports[0] ?? "mobile") },
    });
    if (res.ok) {
      const html = await res.text();
      platform = detectPlatform({ url: opts.prod, html });
      if (opts.autoSelectors !== false && isLlmAvailable()) {
        const discovered = await discoverSelectorsFromUrl(opts.prod, html, {});
        if (discovered) mergeDiscoveredSelectors(rc.selectors, discovered);
      }
    }
  } catch {
    /* discovery skipped */
  }

  const spinner = ora("Lançando browser…").start();
  const sides: SideBenchmark[] = [];
  let favicon: string | null = null;
  let logo: string | null = null;
  const browser = await launchBrowser({ headless: true });
  spinner.succeed("Browser pronto");

  try {
    for (const viewport of viewports) {
      console.log(chalk.bold(`\n  ── ${viewport} ─────────────────────────────`));
      const onEvent = (m: string) => console.log(chalk.dim(`  ${m}`));

      // Scout ("batedor"): discover a PLP + PDP that WORK ON BOTH SITES, so we
      // never measure a broken page. If nothing validates on both, abort with a
      // clear message instead of benchmarking an error page.
      onEvent("batedor: procurando PLP + PDP que funcionem nos DOIS sites…");
      const targetPaths = await resolveTargetPaths({
        browser,
        prodBase: opts.prod,
        candBase: opts.cand,
        viewport,
        rc,
        learned,
        platform,
        outDir: paths.screenshotsDir,
        onEvent,
      });
      if (!targetPaths) {
        console.error(
          chalk.red(
            `\n  ✗ batedor não achou uma PLP + PDP que funcionem nos dois sites (${viewport}).\n    Verifique se as URLs batem e/ou passe --plp com uma categoria que exista nos DOIS.`,
          ),
        );
        return 2;
      }
      onEvent(`PLP: ${targetPaths.categoryPath} · PDP: ${targetPaths.productPath}`);
      favicon ??= targetPaths.favicon;
      logo ??= targetPaths.logo;

      const runOne = (side: Side, base: string) =>
        runSideBenchmark({
          browser,
          base,
          side,
          viewport,
          rc,
          learned,
          platform,
          outDir: paths.screenshotsDir,
          harPath: join(paths.harDir, `user-navigation-benchmark-${viewport}-${side}.har`),
          lighthouseDir: join(paths.runDir, "lighthouse"),
          warmupRuns,
          measuredRuns,
          paginations,
          runVitals,
          targetPaths,
          onEvent,
        });
      // prod and cand in parallel — halves wall time; Lighthouse runs after each
      // side closes its own context, so they never fight over the CPU.
      const [prod, cand] = await Promise.all([
        runOne("prod", opts.prod),
        runOne("cand", opts.cand),
      ]);
      sides.push(prod, cand);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const report: BenchmarkReport = {
    prodUrl: opts.prod,
    candUrl: opts.cand,
    timestamp: new Date().toISOString(),
    viewports,
    warmupRuns,
    measuredRuns,
    paginations,
    runVitals,
    favicon,
    logo,
    sides,
  };

  writeFileSync(paths.reportJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const html = renderBenchmarkHtml(report, { lang });
  writeFileSync(paths.reportHtml, html, "utf8");

  printSummary(report);
  console.log(chalk.dim(`  → ${paths.reportHtml}`));
  console.log(chalk.dim(`  → HAR: ${paths.harDir}/user-navigation-benchmark-*.har`));
  console.log("");

  if (opts.open) {
    const { default: open } = await import("open");
    await open(paths.reportHtml).catch(() => undefined);
  }
  return 0;
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function printSummary(report: BenchmarkReport): void {
  for (const viewport of report.viewports) {
    const prod = report.sides.find((s) => s.viewport === viewport && s.side === "prod");
    const cand = report.sides.find((s) => s.viewport === viewport && s.side === "cand");
    if (!prod || !cand) continue;
    console.log("");
    console.log(chalk.bold(`  [${viewport}] tempo total da jornada`));
    const speedup = cand.totalMs > 0 ? prod.totalMs / cand.totalMs : 0;
    console.log(
      `    Fresh ${chalk.cyan(fmt(prod.totalMs))} → TanStack ${chalk.magenta(fmt(cand.totalMs))}  ${speedup >= 1 ? chalk.green(`${speedup.toFixed(1)}× mais rápido`) : chalk.yellow(`${speedup.toFixed(2)}×`)}`,
    );
    for (const cs of cand.steps) {
      const ps = prod.steps.find((s) => s.step === cs.step);
      const flag =
        ps?.ok === false || cs.ok === false
          ? chalk.red(`  ✗ ERRO: ${cs.ok === false ? "cand" : "prod"} ${cs.note ?? ""}`)
          : "";
      console.log(
        `      ${cs.step.padEnd(16)} prod ${fmt(ps?.ms ?? 0).padStart(8)}   cand ${fmt(cs.ms).padStart(8)}${flag}`,
      );
    }
  }
  const failed = report.sides.flatMap((s) =>
    s.steps.filter((st) => st.ok === false).map((st) => `${s.side}/${st.step}`),
  );
  if (failed.length > 0) {
    console.log("");
    console.log(
      chalk.red(
        `  ⚠ ${failed.length} passo(s) com erro (${failed.join(", ")}) — tempos não confiáveis nesses passos. Veja o report.`,
      ),
    );
  }
}
