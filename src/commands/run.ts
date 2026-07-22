import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Browser } from "playwright";
import { runAllChecks } from "../checks/index.ts";
import type { CheckContext } from "../checks/index.ts";
import { pairCaptures } from "../checks/lib/pairing.ts";
import { resolveSitemapUrls } from "../diff/sitemap.ts";
import { launchBrowser, newContext, stopTracing, userAgentFor } from "../engine/browser.ts";
import { capturePage, installVitalsCollector } from "../engine/collect.ts";
import { runFlow } from "../engine/flows.ts";
import { disableInteractive, isInteractiveMode } from "../engine/interactive-selector-prompt.ts";
import { discoverPagesFromSitemap } from "../engine/sitemap-discover.ts";
import { SCORE_VERSION, computeVerdict } from "../engine/verdict.ts";
import { loadParityIgnore, loadParityRc } from "../ignore/parser.ts";
import { type Platform, detectPlatform } from "../learned/platform.ts";
import { promoteStepsFromFlow } from "../learned/promote.ts";
import { type LearnedSelectors, loadLearned, saveLearned } from "../learned/repo.ts";
import { aggregateIssues } from "../llm/aggregate-issues.ts";
import {
  disableLlm,
  isLlmAvailable,
  providerLabel,
  setForcedProvider,
  setLlmLanguage,
} from "../llm/client.ts";
import { discoverSelectorsFromUrl, mergeDiscoveredSelectors } from "../llm/discover-selectors.ts";
import { fingerprintPdp, matchPdps } from "../llm/match-pdp.ts";
import {
  type ModelTier,
  type Provider,
  applyModelOverrides,
  parseFeatureOverrides,
} from "../llm/models.ts";
import { groupIssues } from "../report/group-issues.ts";
import { renderHtmlReport } from "../report/render.ts";
import { compareToBaseline, loadBaseline } from "../storage/baselines.ts";
import {
  createRunDir,
  findPreviousRun,
  newRunId,
  writeRunReportHtml,
  writeRunReportJson,
} from "../storage/fs.ts";
import { JsonlWriter, checkToJsonl } from "../storage/jsonl.ts";
import type {
  CheckResult,
  FlowCapture,
  FlowName,
  Issue,
  PageCapture,
  Run,
  SeoSummary,
  Side,
  Verdict,
  Viewport,
  VisualDiffSummary,
} from "../types/schema.ts";
import { attachSpinnerHeartbeat } from "../util/heartbeat.ts";
import { isLocalhost } from "../util/localhost.ts";
import { TimingRegistry, buildFlowBreakdown, formatTimingsSummary } from "../util/timing.ts";
import { serveRunAndBlock } from "./serve.ts";

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
  /** When false, don't write to learned-selectors.json (read-only mode) */
  learn?: boolean;
  /** Extra pages (beyond flows) to crawl just for Web Vitals coverage. Default 10. */
  vitalsPages?: number;
  /**
   * How many viewports run concurrently during collect. Default 2, which
   * means the standard `mobile,desktop` set runs fully in parallel (with
   * each viewport already running its prod+cand sides in parallel via
   * `runOneSide`). Set to 1 on memory-constrained machines or for runs
   * with >2 viewports if Chromium memory becomes an issue.
   */
  maxViewportConcurrency?: number;
  /** Pages to compare visually (prod vs cand screenshots + LLM). Default 5. */
  visualPages?: number;
  /** Disable the visual-diff capture pass entirely. */
  noVisualDiff?: boolean;
  /**
   * Comma-separated paths to compare visually. When set, overrides
   * sitemap-based sampling — the caller takes responsibility for picking
   * which routes get verified. Recommended for agent loops that need
   * deterministic coverage of specific flows (home, /account, a known PDP).
   */
  pages?: string;
  /** Path to a text file with one path per line. Overrides --pages when both are set. */
  pagesFile?: string;
  /**
   * Disable the cross-run cache that persists visual verdicts at
   * `<output>/cache/verdicts.json`. By default the cache is enabled so
   * re-runs skip the LLM call for pages whose screenshots haven't changed.
   */
  cache?: boolean;
  /** Wipe the cache file before the run starts. */
  clearCache?: boolean;
  /** Named bundle of defaults. Individual flags still override the preset. */
  preset?: "smoke" | "full" | "ci";
  /**
   * Bypass intermediary caches: append cache-busting query param + send
   * Cache-Control/Pragma: no-cache on every navigation. Use right after a
   * deploy to avoid false failures from stale CF edge content.
   */
  bypassCache?: boolean;
  /**
   * Before measurement, hit each target URL once with a cache-buster so the
   * Worker serves a fresh response. Pairs with --bypass-cache after deploys.
   */
  warmup?: boolean;
  /**
   * Demote prod-side cart-empty failures to `skipped` when the VTEX
   * session quirk hits (cart genuinely empty after navigation). The
   * separate `cart-reveal-mode-divergence` check still emits `critical`
   * if prod and cand markup intents differ — so this flag never masks
   * a real regression. Issue #12.
   */
  acceptProdQuirks?: boolean;
  /**
   * Hard timeout in seconds for the LLM aggregation call. The run
   * completes in offline mode if the LLM hangs past this. Default: 60.
   * Issue #52.
   */
  llmTimeout?: number;
  /**
   * Wall-clock cap for the whole run (minutes). On expiry, parity writes
   * a partial report and exits 130. Default: 30. Issue #56.
   */
  timeout?: number;
  /**
   * Alias for `flows` when only one flow is being run. CLI sugar that
   * commander maps before `runCommand` is invoked. Issue #53.
   */
  flow?: string;
  /**
   * Stream check results as JSON-Lines to a file path or `-` for stdout.
   * Lets agents/scripts consume each check as it completes, instead of
   * scraping the HTML report. Issue #53.
   */
  json?: string;
  /**
   * Tell the LLM to respond in Brazilian Portuguese. Only affects
   * LLM-generated content (issues, explain, prompts) — the static
   * HTML report stays in English. Issue #67.
   */
  pt?: boolean;
  /**
   * Force LLM provider. `claude-code` uses the local `claude` CLI via the
   * Claude Agent SDK. Defaults to auto-detect. Issue #66.
   */
  llm?: "anthropic" | "openrouter" | "claude-code" | "none" | "auto";
  /**
   * Per-feature model override: `<feature>=<model>,...`. See `src/llm/models.ts`
   * for the list of features. Issue #66.
   */
  llmModel?: string;
  /** Override the default tier (haiku/sonnet/opus). Issue #66. */
  llmTierDefault?: "haiku" | "sonnet" | "opus";
  /** Force every LLM call to use this exact model ID. Issue #66. */
  llmModelDefault?: string;
  /**
   * Disable the interactive selector prompt that auto-fires when running
   * in a TTY without an LLM provider. Set by `--no-interactive`. Issue #72.
   */
  interactive?: boolean;
}

type PresetDefaults = Partial<
  Pick<
    RunOptions,
    "flows" | "viewports" | "vitalsPages" | "visualPages" | "noVisualDiff" | "autoSelectors"
  >
>;

/**
 * Named bundles of defaults so users don't have to remember every flag.
 * Individual flags passed by the user always win over preset values.
 */
const PRESETS: Record<NonNullable<RunOptions["preset"]>, PresetDefaults> = {
  // ~30s smoke run — homepage only, one viewport, skip extra crawls + LLM
  smoke: {
    flows: "homepage",
    viewports: "mobile",
    vitalsPages: 0,
    visualPages: 0,
    noVisualDiff: true,
    autoSelectors: false,
  },
  // Full audit — purchase journey + search + cart interactions, both viewports,
  // visual diff, extra vitals. Catches more regressions at the cost of ~2× runtime.
  full: {
    flows: "purchase-journey,search,cart-interactions",
    viewports: "mobile,desktop",
    vitalsPages: 10,
    visualPages: 5,
  },
  // CI-friendly — purchase journey on mobile, smaller crawls, no extra browser opens
  ci: {
    flows: "purchase-journey",
    viewports: "mobile",
    vitalsPages: 5,
    visualPages: 3,
  },
};

/**
 * Apply LLM-availability heuristics to the resolved options. Issue #71:
 * Several flags are wasteful when no LLM provider is available — e.g.
 * `--visual-pages 5` captures screenshots and computes pixelmatch heatmaps
 * but the semantic analysis (the actual value) is LLM-only. We auto-zero
 * those numeric defaults when no LLM is configured, unless the user
 * explicitly set them.
 *
 * Detection is intentionally conservative: we only auto-disable if the
 * caller never touched the flag (still equals commander's default).
 */
function applySmartDefaults(opts: RunOptions, llmAvailable: boolean): RunOptions {
  if (llmAvailable) return opts;
  const merged: RunOptions = { ...opts };
  const COMMANDER_DEFAULTS: Record<string, unknown> = {
    visualPages: 5,
  };
  const mergedRec = merged as unknown as Record<string, unknown>;
  // Without LLM the visual diff has no analysis layer — skip the capture
  // pass entirely to save ~10-30s per page. Users can still opt in with
  // `--visual-pages N` to get the prod/cand screenshots + pixelmatch heatmap.
  if (mergedRec.visualPages === COMMANDER_DEFAULTS.visualPages) {
    mergedRec.visualPages = 0;
    mergedRec.noVisualDiff = true;
  }
  return merged;
}

function applyPreset(opts: RunOptions): RunOptions {
  if (!opts.preset) return opts;
  const preset = PRESETS[opts.preset];
  if (!preset) return opts;
  // Merge preset BENEATH user-provided opts (user wins on every key explicitly set)
  // We detect "user-provided" as "not equal to commander's static default".
  const merged: RunOptions = { ...opts };
  // Defaults from commander that we treat as "not user-set" for the preset merge
  const COMMANDER_DEFAULTS: Record<string, unknown> = {
    flows: "purchase-journey",
    viewports: "mobile,desktop",
    vitalsPages: 10,
    visualPages: 5,
  };
  const mergedRec = merged as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(preset)) {
    const currentVal = mergedRec[k];
    const defaultVal = COMMANDER_DEFAULTS[k];
    const isUserSet = currentVal !== undefined && currentVal !== defaultVal;
    if (!isUserSet) {
      mergedRec[k] = v;
    }
  }
  return merged;
}

const SEVERITY_RANK: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Apply `--llm*` flags to the provider/model registry. Returns a user-facing
 * error string if any flag was malformed; `null` on success. Called once
 * before any LLM activity. Issue #66.
 */
function applyLlmOptions(opts: RunOptions): string | null {
  const llmFlag = opts.llm;
  if (llmFlag && llmFlag !== "auto") {
    if (llmFlag === "none") {
      disableLlm();
    } else {
      const map: Record<string, Provider> = {
        anthropic: "anthropic",
        openrouter: "openrouter",
        "claude-code": "claude-agent-sdk",
      };
      const target = map[llmFlag];
      if (!target)
        return `--llm: invalid provider "${llmFlag}" (valid: anthropic, openrouter, claude-code, none, auto)`;
      const err = setForcedProvider(target);
      if (err) return err;
    }
  }
  if (opts.llmModel) {
    const { overrides, errors } = parseFeatureOverrides(opts.llmModel);
    if (errors.length) return `--llm-model: ${errors.join("; ")}`;
    applyModelOverrides({ perFeature: overrides });
  }
  if (opts.llmTierDefault) {
    const tier = opts.llmTierDefault as ModelTier;
    if (!["haiku", "sonnet", "opus"].includes(tier)) {
      return `--llm-tier-default: invalid tier "${opts.llmTierDefault}" (valid: haiku, sonnet, opus)`;
    }
    applyModelOverrides({ defaultTier: tier });
  }
  if (opts.llmModelDefault) {
    applyModelOverrides({ defaultModel: opts.llmModelDefault });
  }
  return null;
}

export async function runCommand(rawOpts: RunOptions): Promise<number> {
  let opts = applyPreset(rawOpts);
  if (rawOpts.preset) {
    console.log(chalk.dim(`  preset: ${rawOpts.preset}`));
  }
  if (opts.pt) setLlmLanguage("pt");
  // commander stores --no-interactive as `interactive: false`. We only act
  // on the explicit false; undefined leaves auto-detect alone. Issue #72.
  if (opts.interactive === false) disableInteractive();
  const llmCfgErr = applyLlmOptions(opts);
  if (llmCfgErr) {
    console.error(chalk.red(`  ${llmCfgErr}`));
    return 2;
  }
  // Apply smart defaults AFTER --llm flags are applied so the heuristic
  // reads the user's final intent (--llm none disables LLM-dependent capture
  // even when the env has a key). Issue #71.
  const llmStillAvailable = isLlmAvailable();
  const preSmart = opts;
  opts = applySmartDefaults(opts, llmStillAvailable);
  if (!llmStillAvailable && opts.visualPages !== preSmart.visualPages) {
    console.log(
      chalk.dim(
        "  visual-pages auto-set to 0 (no LLM available — analysis layer would be skipped; opt in with --visual-pages N)",
      ),
    );
  }
  const flows = opts.flows.split(",").map((s) => s.trim()) as FlowName[];
  const viewports = opts.viewports.split(",").map((s) => s.trim()) as Viewport[];
  const failOn = opts.failOn
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Issue["severity"][];

  const rc = loadParityRc();
  rc.cep = opts.cep || rc.cep;
  const ignore = loadParityIgnore();

  if (opts.clearCache) {
    const cacheFile = join(opts.output, "cache", "verdicts.json");
    if (existsSync(cacheFile)) {
      try {
        unlinkSync(cacheFile);
        console.log(chalk.dim(`  cache wiped: ${cacheFile}`));
      } catch (err) {
        console.log(chalk.yellow(`  cache wipe falhou: ${(err as Error).message}`));
      }
    }
  }

  // Print LLM mode banner so the user knows what the aggregation phase will
  // attempt before it starts (issue #52). Online mode shows the provider +
  // timeout so a hang past the budget is auditable from the log alone.
  // Validate --llm-timeout: reject NaN explicitly (commander hands NaN
  // through unchanged when the user types `--llm-timeout foo`, and
  // `setTimeout(NaN)` fires immediately, which would silently downgrade
  // the timeout to ~5s). Review feedback on PR #58.
  const llmTimeoutRaw = opts.llmTimeout ?? 60;
  if (!Number.isFinite(llmTimeoutRaw)) {
    console.error(chalk.red(`  --llm-timeout inválido: "${opts.llmTimeout}" não é um número`));
    return 2;
  }
  const llmTimeoutSec = Math.max(5, Math.floor(llmTimeoutRaw));
  if (isLlmAvailable()) {
    console.log(chalk.dim(`  llm: ${providerLabel()} (timeout=${llmTimeoutSec}s)`));
  } else {
    console.log(chalk.dim("  llm: offline (LLM keys ausentes — agregação heurística)"));
  }
  if (isInteractiveMode()) {
    console.log(
      chalk.dim(
        "  interactive: enabled — TTY + no LLM. Missing selectors will pause to prompt (disable with --no-interactive). Issue #72.",
      ),
    );
  }

  // Pre-flight: confirm both URLs respond before spending 10 minutes on a
  // doomed run. We send the UA of the first viewport so the warm-up hits the
  // same device-segmented cache bucket the measurement loop will read from.
  const primaryViewport = viewports[0] ?? "mobile";
  const preflight = await preflightCheck(opts.prod, opts.cand, primaryViewport);
  if (!preflight.ok) {
    console.error(chalk.red("\n  ✖ pre-flight falhou:"));
    for (const err of preflight.errors) console.error(chalk.red(`    - ${err}`));
    console.error(chalk.dim("\n  dica: verifique se as URLs estão corretas e acessíveis"));
    return 2;
  }

  // Load learned-selectors library + detect platform from prod home
  const learned = loadLearned();
  const learnedBefore = JSON.stringify(learned);
  let platform: Platform = "custom";
  const prodHomeHtml = await fetchHomeHtml(opts.prod, primaryViewport);
  if (prodHomeHtml) {
    platform = detectPlatform({ url: opts.prod, html: prodHomeHtml });
    if (platform !== "custom") {
      console.log(chalk.dim(`  Detected platform: ${platform}`));
    }
  }
  const prodHost = hostOf(opts.prod);
  let promotedCount = 0;
  let deprecatedCount = 0;

  // LLM-based selector discovery (auto, but user .parityrc.json overrides always win)
  const wantsAutoSelectors = opts.autoSelectors !== false && isLlmAvailable();
  if (wantsAutoSelectors) {
    const discoverSpinner = ora("Descobrindo seletores via LLM (analisando home prod)…").start();
    try {
      const html = prodHomeHtml ?? (await fetchHomeHtml(opts.prod, primaryViewport));
      if (html) {
        const discovered = await discoverSelectorsFromUrl(opts.prod, html, {
          noCache: opts.refreshSelectors === true,
        });
        if (discovered) {
          mergeDiscoveredSelectors(rc.selectors, discovered);
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

  // Issue #53: JSON-Lines streaming for agents/scripts. Opened now so the
  // metadata line lands before any check noise; closed in `finally`.
  const jsonl = opts.json ? new JsonlWriter(opts.json) : null;
  jsonl?.write({
    type: "metadata",
    schemaVersion: "1.0",
    runId,
    prodUrl: opts.prod,
    candUrl: opts.cand,
    flows: flows as string[],
    viewports: viewports as string[],
    timestamp,
  });

  console.log(chalk.bold(`\n  parity run ${runId}`));
  console.log(chalk.dim(`  prod: ${opts.prod}`));
  console.log(chalk.dim(`  cand: ${opts.cand}`));
  console.log(
    chalk.dim(
      `  flows: ${flows.join(", ")} · viewports: ${viewports.join(", ")} · CEP: ${rc.cep}\n`,
    ),
  );

  const spinner = ora("Launching browser…").start();
  let browser: Browser | null = null;
  const allFlowCaptures: FlowCapture[] = [];
  const allPageCaptures: PageCapture[] = [];

  // Always-visible elapsed counter. From the moment "Launching browser…"
  // appears the user sees `⏱ 04:32 · <whatever the current label is>`
  // refreshed every second — no more silent terminals for minutes. The
  // `setSpinnerLabel` wrapper is used in place of `spinner.text = …`
  // anywhere that wants to set what's *happening now*; the ticker
  // re-renders the prefix every second from the stored label so the
  // elapsed time always advances even if no new step events arrive.
  let currentSpinnerLabel = "Launching browser…";
  const renderSpinner = (): void => {
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    const min = Math.floor(elapsedSec / 60);
    const sec = elapsedSec % 60;
    const mmss = `${min.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
    spinner.text = `${chalk.dim(`⏱ ${mmss} ·`)} ${currentSpinnerLabel}`;
  };
  const setSpinnerLabel = (label: string): void => {
    currentSpinnerLabel = label;
    renderSpinner();
  };
  setSpinnerLabel("Launching browser…");
  const elapsedTicker = setInterval(renderSpinner, 1000);
  elapsedTicker.unref?.();

  // Per-phase timing accumulator. Each phase boundary pushes its duration
  // so the report header + console summary can show where the wall-clock
  // actually went (observability follow-up to #56's `currentPhase`).
  const timings = new TimingRegistry();
  let phaseStart = performance.now();
  const stampPhase = (label: string): void => {
    timings.push(label, performance.now() - phaseStart);
    phaseStart = performance.now();
  };

  // Issue #56: install SIGINT/SIGTERM + global timeout so a Ctrl-C or a
  // wedged phase doesn't leave the user with no report. The shutdown
  // helper is idempotent (a 2nd signal hard-exits 130).
  let currentPhase = "launch";
  let shuttingDown = false;
  const partialChecks: CheckResult[] = [];
  const shutdown = (reason: string) => {
    if (shuttingDown) {
      // 2nd signal: hard exit. The 1st already kicked off cleanup.
      process.stderr.write("\n  segunda interrupção — forçando saída.\n");
      process.exit(130);
    }
    shuttingDown = true;
    spinner.stop();
    process.stderr.write(
      `\n  ⚠ run interrompido (${reason}) durante "${currentPhase}" — escrevendo report parcial…\n`,
    );
    try {
      // Stamp the current in-flight phase so the user sees how long the
      // wedged phase lasted before the interrupt. Snapshot timings now
      // so the partial report carries the "where the time went so far"
      // data — the PR's motivating use case (review feedback on PR #60).
      stampPhase(currentPhase);
      const partialTimings = timings.finalize();
      const partial = buildPartialRun({
        runId,
        timestamp,
        prodUrl: opts.prod,
        candUrl: opts.cand,
        flows,
        viewports,
        cep: rc.cep,
        startedAt,
        flowCaptures: allFlowCaptures,
        checks: partialChecks,
        partialReason: `${reason} during ${currentPhase}`,
        timings: partialTimings,
      });
      writeRunReportJson(paths.runDir, partial);
      const html = renderHtmlReport(partial, paths.runDir);
      writeRunReportHtml(paths.runDir, html);
      process.stderr.write(`  report parcial em ${paths.reportHtml}\n`);
      // Print the timing summary to stderr too so the shutdown path
      // surfaces it (success path prints to stdout).
      process.stderr.write(
        `\n${formatTimingsSummary(partialTimings, buildFlowBreakdown(allFlowCaptures))}\n`,
      );
    } catch (err) {
      process.stderr.write(`  falha escrevendo report parcial: ${(err as Error).message}\n`);
    }
    // Best-effort browser close.
    if (browser) {
      browser.close().catch(() => undefined);
    }
    process.exit(130);
  };
  const onSignal = (sig: NodeJS.Signals) => {
    shutdown(`signal ${sig}`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const timeoutMinutes = Math.max(1, Math.floor(opts.timeout ?? 30));
  const globalTimeoutTimer = setTimeout(() => {
    shutdown(`timeout ${timeoutMinutes}min`);
  }, timeoutMinutes * 60_000);
  // Don't block process exit on the timer.
  globalTimeoutTimer.unref?.();

  try {
    browser = await launchBrowser({ headless: true });

    if (opts.warmup) {
      const warmupSpinner = ora("Warmup: bustando cache em prod + cand…").start();
      const result = await warmupTargets({
        urls: [opts.prod, opts.cand],
        viewports,
        bypassCache: opts.bypassCache !== false,
      });
      if (result.failed.length === 0) {
        warmupSpinner.succeed(
          `Warmup ok — ${result.succeeded}/${result.attempted} workers serviram resposta fresca`,
        );
      } else if (result.succeeded > 0) {
        const failureSummary = result.failed
          .slice(0, 3)
          .map((f) => `${f.viewport}/${hostOf(f.url)} (${f.reason})`)
          .join("; ");
        warmupSpinner.warn(
          `Warmup parcial — ${result.succeeded}/${result.attempted} ok; ${result.failed.length} falha(s): ${failureSummary}`,
        );
      } else {
        const firstReason = result.failed[0]?.reason ?? "unknown";
        warmupSpinner.fail(
          `Warmup falhou — 0/${result.attempted} requests ok. Cache pode estar stale. Primeira falha: ${firstReason}`,
        );
      }
    }

    // Per-side runner. Sides for a given viewport are independent (each
    // creates its own BrowserContext, writes to its own HAR/trace path)
    // so prod and cand can — and now do — run in parallel. The function
    // returns its captures + promotion deltas instead of mutating the
    // outer accumulators directly; the caller merges after Promise.all
    // resolves so `learned`, `allFlowCaptures`, etc. never see partial
    // writes from the racing side.
    const runOneSide = async (
      viewport: Viewport,
      side: Side,
    ): Promise<{ captures: FlowCapture[]; pages: PageCapture[] }> => {
      const baseUrl = side === "prod" ? opts.prod : opts.cand;
      const harPath = join(paths.harDir, `${viewport}-${side}.har`);
      const tracePath = join(paths.tracesDir, `${viewport}-${side}.zip`);
      const ctx = await newContext(browser!, {
        viewport,
        harPath,
        tracesDir: paths.tracesDir,
        cohortCookieValue: "control",
        noCache: opts.bypassCache,
      });
      await installVitalsCollector(ctx);
      const captures: FlowCapture[] = [];
      const pages: PageCapture[] = [];
      try {
        for (const flow of flows) {
          const flowStart = Date.now();
          let lastStepTotal = 0;
          const sideTag = side === "prod" ? chalk.cyan("prod") : chalk.magenta("cand");
          const prefix = `${chalk.dim(`[${viewport}/`)}${sideTag}${chalk.dim("]")}`;
          setSpinnerLabel(`${prefix} ${flow}: starting…`);
          const cap = await runFlow(flow, {
            baseUrl,
            side,
            viewport,
            rc,
            ctx,
            outDir: paths.screenshotsDir,
            runId,
            learned,
            platform,
            recoveryBudget: 3,
            acceptProdQuirks: opts.acceptProdQuirks,
            onStep: (event) => {
              if (event.phase === "start") {
                lastStepTotal = event.total;
                setSpinnerLabel(
                  `${prefix} ${flow} ${chalk.dim(`${event.index}/${event.total}`)} ${event.name}…`,
                );
              }
            },
          });
          // Per-flow summary line: prints permanently above the live
          // spinner so the user can see exactly where each side ended.
          // Showing `2/9 stopped at open-minicart` makes the ratio
          // meaningful across sides ("desk got further than mobile").
          const okSteps = cap.steps?.filter((s) => s.status === "ok").length ?? 0;
          const recorded = cap.steps?.length ?? 0;
          const target = lastStepTotal || recorded;
          const failed = cap.steps?.find((s) => s.status === "failed");
          const lastStep = cap.steps?.[cap.steps.length - 1];
          const elapsedDim = chalk.dim(`${((Date.now() - flowStart) / 1000).toFixed(1)}s`);
          const counts = target > 0 ? chalk.dim(`${okSteps}/${target}`) : "";
          let glyph: string;
          let detail: string;
          if (failed) {
            glyph = chalk.red("✗");
            detail = `stopped at ${chalk.yellow(failed.name)}`;
          } else if (target > 0 && okSteps < target) {
            glyph = chalk.yellow("▴");
            detail = lastStep ? `ended at ${chalk.dim(lastStep.name)}` : "incomplete";
          } else {
            glyph = chalk.green("✓");
            detail = "";
          }
          const summary = `${glyph} ${prefix} ${flow} ${counts} ${detail} ${elapsedDim}`
            .replace(/\s+/g, " ")
            .trim();
          spinner.stopAndPersist({ symbol: "", text: summary });
          setSpinnerLabel(`${prefix} ${flow} done — next…`);
          spinner.start();
          captures.push(cap);
          for (const p of cap.pages) pages.push(p);
        }
      } finally {
        await stopTracing(ctx, tracePath).catch(() => undefined);
        await ctx.close();
      }
      return { captures, pages };
    };

    // Per-viewport runner. Each viewport runs its two sides in parallel
    // (via runOneSide × Promise.all). Viewports themselves can also run
    // in parallel — up to `maxViewportConcurrency` (default 2, i.e. the
    // default mobile+desktop set runs fully parallel). Cap exists for
    // memory-constrained machines and for runs with >2 viewports.
    const runOneViewport = async (viewport: Viewport): Promise<void> => {
      const [prodResult, candResult] = await Promise.all([
        runOneSide(viewport, "prod"),
        runOneSide(viewport, "cand"),
      ]);
      // Merge into shared accumulators sequentially (single-threaded
      // after the awaits, so no need for locks). Promotion runs here too
      // so `learned` is never touched concurrently — promoteStepsFromFlow
      // is deterministic over captures, so the deferral changes no
      // semantics.
      for (const r of [prodResult, candResult]) {
        for (const cap of r.captures) {
          allFlowCaptures.push(cap);
          if (opts.learn !== false) {
            const result = promoteStepsFromFlow(learned, platform, prodHost, cap);
            promotedCount += result.promoted;
            deprecatedCount += result.deprecated;
          }
        }
        for (const p of r.pages) allPageCaptures.push(p);
      }
    };

    const maxViewportConcurrency = Math.max(1, opts.maxViewportConcurrency ?? 2);
    await runWithConcurrency(viewports, maxViewportConcurrency, runOneViewport);
    stampPhase("collect");
    spinner.succeed("Coleta concluída");

    // LLM PDP cross-site matcher: confirm prod and cand opened the same product
    if (isLlmAvailable()) {
      const prodPdp = findPdpCapture(allFlowCaptures, "prod");
      const candPdp = findPdpCapture(allFlowCaptures, "cand");
      if (prodPdp && candPdp) {
        const fpProd = fingerprintPdp(prodPdp.html);
        const fpCand = fingerprintPdp(candPdp.html);
        const verdict = await matchPdps(fpProd, fpCand);
        if (verdict !== "same") {
          spinner.warn(
            `PDP cross-site matcher: '${verdict}' (prod="${fpProd.name ?? "?"}" cand="${fpCand.name ?? "?"}")`,
          );
        }
      }
    }

    // Persist learned-selectors if it changed
    if (opts.learn !== false && JSON.stringify(learned) !== learnedBefore) {
      saveLearned(learned);
    }

    // Extra vitals coverage: crawl additional pages from sitemap to enrich the Vitals tab.
    // Issue #55: a Vite/Webpack dev server (cand=localhost) never reaches
    // networkidle because HMR/SSE keep the network busy. We auto-detect and
    // (a) cap vitalsPages at 3 unless the user opted into more, (b) tell
    // capturePage to skip networkidle entirely.
    const candIsDevServer = isLocalhost(opts.cand);
    const vitalsPagesDefault = candIsDevServer ? 3 : 10;
    const vitalsPagesLimit = opts.vitalsPages ?? vitalsPagesDefault;
    if (candIsDevServer && vitalsPagesLimit > 0) {
      console.log(
        chalk.dim(
          `  cand=localhost detectado — vitals-pages=${vitalsPagesLimit}, networkidle desabilitado (issue #55)`,
        ),
      );
    }
    if (browser && vitalsPagesLimit > 0) {
      currentPhase = "vitals-pages";
      const extraSpinner = ora("Coletando vitals em páginas extras…").start();
      const vitalsHb = attachSpinnerHeartbeat(extraSpinner, {
        baseText: "Coletando vitals em páginas extras…",
      });
      // try/finally ensures stampPhase runs even if an uncaught error
      // bubbles past the inner catch. Without this, phaseStart never
      // advances and the next phase silently absorbs the vitals time.
      // Review feedback on PR #60.
      try {
        const allUrls = await resolveSitemapUrls(opts.prod);
        const visitedPaths = new Set<string>();
        for (const p of allPageCaptures) {
          try {
            visitedPaths.add(new URL(p.url).pathname);
          } catch {
            /* skip */
          }
        }
        const buckets = new Map<string, string[]>();
        for (const u of allUrls) {
          let p = "/";
          try {
            p = new URL(u).pathname || "/";
          } catch {
            continue;
          }
          if (visitedPaths.has(p)) continue;
          const seg = p.split("/").filter(Boolean)[0] ?? "_root";
          const arr = buckets.get(seg) ?? [];
          arr.push(p);
          buckets.set(seg, arr);
        }
        const extraPaths: string[] = [];
        const keys = [...buckets.keys()];
        let idx = 0;
        while (
          extraPaths.length < vitalsPagesLimit &&
          keys.some((k) => (buckets.get(k)?.length ?? 0) > 0)
        ) {
          const k = keys[idx % keys.length]!;
          const next = buckets.get(k)!.shift();
          if (next) extraPaths.push(next);
          idx++;
        }
        if (extraPaths.length > 0) {
          extraSpinner.text = `${extraPaths.length} página(s) extras × 2 sides × ${viewports.length} viewport(s)…`;
          const mobileOnly = viewports.includes("mobile") ? (["mobile"] as Viewport[]) : viewports;
          const tasks: Array<{ path: string; viewport: Viewport; side: Side }> = [];
          for (const viewport of mobileOnly) {
            for (const path of extraPaths) {
              for (const side of ["prod", "cand"] as Side[]) {
                tasks.push({ path, viewport, side });
              }
            }
          }
          let done = 0;
          await runWithConcurrency(tasks, 4, async (task) => {
            const baseUrl = task.side === "prod" ? opts.prod : opts.cand;
            const fullUrl = new URL(task.path, baseUrl).toString();
            // Issue #55: skip networkidle when targeting a dev server (the side
            // that's localhost) — HMR / SSE keep network active indefinitely.
            const targetIsDevServer = isLocalhost(baseUrl);
            // Hard wall-clock per task so one wedged page can't stall the whole
            // worker. capturePage already has its own outer Promise.race (60s
            // outer deadline for non-fast captures, 35s for fast), but this
            // belt-and-suspenders bound here ensures even a totally pathological
            // case (browser hang BEFORE Promise.race installs) doesn't poison
            // the spinner. Issue #55.
            const PER_TASK_WALLCLOCK_MS = 35_000;
            try {
              const ctx = await newContext(browser!, {
                viewport: task.viewport,
                cohortCookieValue: "control",
                noCache: opts.bypassCache,
              });
              await installVitalsCollector(ctx);
              const page = await ctx.newPage();
              try {
                const cap = await Promise.race<PageCapture | null>([
                  capturePage(page, {
                    url: fullUrl,
                    side: task.side,
                    viewport: task.viewport,
                    screenshotPath: `${paths.screenshotsDir}/extra-${task.path.replace(/[/?&=]+/g, "_")}-${task.viewport}-${task.side}.png`,
                    settleMs: 1200,
                    timeoutMs: 20_000,
                    fast: true,
                    scrollToLoad: false,
                    skipScreenshot: true,
                    noNetworkIdle: targetIsDevServer,
                  }),
                  new Promise<null>((resolve) => {
                    // .unref() so the timer never holds the event loop
                    // open past the parent run's natural completion.
                    const t = setTimeout(() => resolve(null), PER_TASK_WALLCLOCK_MS);
                    t.unref?.();
                  }),
                ]);
                if (!cap) {
                  // Wall-clock fired before capture returned. Skip; the next
                  // task continues. Without this guard, a hung page kept the
                  // worker busy until the outer global timeout fired.
                  return;
                }
                allPageCaptures.push(cap);
                // Also include in a synthetic FlowCapture so the Vitals tab picks it up
                allFlowCaptures.push({
                  flow: "homepage",
                  side: task.side,
                  viewport: task.viewport,
                  pages: [cap],
                  totalDurationMs: cap.durationMs,
                });
              } finally {
                await page.close().catch(() => undefined);
                await ctx.close().catch(() => undefined);
              }
            } catch {
              /* tolerated */
            } finally {
              done++;
              vitalsHb.bump();
              extraSpinner.text = `[vitals extras] ${done}/${tasks.length} (último: ${task.path})`;
            }
          });
          vitalsHb.stop();
          extraSpinner.succeed(`+${extraPaths.length} página(s) com vitals`);
        } else {
          vitalsHb.stop();
          extraSpinner.warn("Nenhuma página extra encontrada no sitemap");
        }
      } catch (err) {
        vitalsHb.stop();
        extraSpinner.warn(`vitals extras pulado: ${(err as Error).message}`);
      } finally {
        stampPhase("vitals-pages");
      }
    }

    // Visual diff capture pass: home + sampled PLPs/PDPs from sitemap, with full-page screenshots
    const explicitPaths = resolveExplicitPages(opts.pagesFile, opts.pages);
    const visualPagesLimit = opts.noVisualDiff
      ? 0
      : explicitPaths
        ? explicitPaths.length
        : (opts.visualPages ?? 5);
    if (browser && visualPagesLimit > 0) {
      currentPhase = "visual-diff";
      const visualSpinnerBaseText = explicitPaths
        ? `Visual diff: ${explicitPaths.length} página(s) explícita(s) via --pages/--pages-file…`
        : "Descobrindo páginas pra visual diff…";
      const visualSpinner = ora(visualSpinnerBaseText).start();
      const visualHb = attachSpinnerHeartbeat(visualSpinner, {
        baseText: visualSpinnerBaseText,
      });
      try {
        const visualPaths =
          explicitPaths ??
          (await discoverPagesFromSitemap(opts.prod, { sampleSize: visualPagesLimit })).all.map(
            (p) => p.path,
          );
        // Always (re-)capture visual-diff pages with the visual-diff capture
        // settings (4s settleMs, 45s timeoutMs, scrollToLoad: true), even when
        // the same path was already captured by a flow (homepage, purchase-
        // journey). Flow captures use shorter settles tuned for click-driven
        // step flow, not for full-page screenshots — using them as the source
        // of truth for visual comparison produced false "missing-component"
        // diffs because lazy-loaded shelves below the fold hadn't rendered.
        // The duplicate captures end up in `allPageCaptures` but `pairCaptures`
        // keys by path::viewport and keeps the last one wins, so the
        // visual-diff capture (pushed after flows) is the one the check uses.

        const tasks: Array<{ path: string; viewport: Viewport; side: Side }> = [];
        for (const viewport of viewports) {
          for (const path of visualPaths) {
            for (const side of ["prod", "cand"] as Side[]) {
              tasks.push({ path, viewport, side });
            }
          }
        }

        if (tasks.length === 0) {
          visualHb.stop();
          visualSpinner.succeed(
            `Visual diff: páginas já capturadas em flows (${visualPaths.length} alvos)`,
          );
        } else {
          visualSpinner.text = `Visual diff: capturando ${tasks.length} screenshot(s) (${visualPaths.length} páginas × ${viewports.length} viewport(s) × 2 sides)…`;
          let done = 0;
          await runWithConcurrency(tasks, 4, async (task) => {
            const baseUrl = task.side === "prod" ? opts.prod : opts.cand;
            const fullUrl = new URL(task.path, baseUrl).toString();
            const safePath = task.path.replace(/[/?&=]+/g, "_") || "_root";
            const screenshotPath = `${paths.screenshotsDir}/visual-${safePath}-${task.viewport}-${task.side}.png`;
            try {
              const ctx = await newContext(browser!, {
                viewport: task.viewport,
                cohortCookieValue: "control",
                noCache: opts.bypassCache,
              });
              await installVitalsCollector(ctx);
              const page = await ctx.newPage();
              try {
                const cap = await capturePage(page, {
                  url: fullUrl,
                  side: task.side,
                  viewport: task.viewport,
                  screenshotPath,
                  // These screenshots are the source of truth for the LLM
                  // visual-diff verdict, so we trade a longer capture for
                  // correctness. The adaptive `scrollFullPage` now does
                  // inter-step skeleton waits AND keeps scrolling until
                  // page height is stable, so heavy pages routinely take
                  // 25-50s here. 90s timeoutMs gives the scroll its full
                  // 45s budget plus headroom for nav + settle + carousel
                  // stabilize + post-scroll skeleton safety net + the
                  // screenshot itself.
                  settleMs: 4_000,
                  timeoutMs: 90_000,
                  scrollToLoad: true,
                });
                allPageCaptures.push(cap);
              } finally {
                await page.close().catch(() => undefined);
                await ctx.close().catch(() => undefined);
              }
            } catch {
              /* tolerated */
            } finally {
              done++;
              visualHb.bump();
              visualSpinner.text = `[visual] ${done}/${tasks.length} (último: ${task.path})`;
            }
          });
          visualHb.stop();
          visualSpinner.succeed(`Visual diff: ${tasks.length} screenshot(s) capturado(s)`);
        }
      } catch (err) {
        visualHb.stop();
        visualSpinner.warn(`Visual diff descoberta pulada: ${(err as Error).message}`);
      } finally {
        stampPhase("visual-diff");
      }
    }

    currentPhase = "checks";
    setSpinnerLabel("Rodando checks…");
    spinner.start();
    const checksHb = attachSpinnerHeartbeat(spinner, { baseText: "Rodando checks…" });
    const cacheDir = join(opts.output, "cache");
    const checkCtx: CheckContext = {
      prodPages: allPageCaptures.filter((p) => p.side === "prod"),
      candPages: allPageCaptures.filter((p) => p.side === "cand"),
      prodFlows: allFlowCaptures.filter((f) => f.side === "prod"),
      candFlows: allFlowCaptures.filter((f) => f.side === "cand"),
      rc,
      ignore,
      outDir: paths.runDir,
      cacheDir,
      noCache: opts.cache === false,
      viewports,
    };
    // Pass partialChecks as the out-array so a SIGINT mid-runAllChecks
    // captures whatever already completed (review feedback on PR #59).
    // The returned `checks` is the SAME array reference, so assigning
    // back is unnecessary.
    const checks = await runAllChecks(checkCtx, partialChecks);
    checksHb.stop();
    stampPhase("checks");
    spinner.succeed(`Checks concluídos (${checks.length})`);

    // Emit each completed check as a JSONL line for agents/scripts (#53).
    // Done in a batch here (vs streaming during runAllChecks) to keep this
    // PR minimally invasive — the writer is buffered + flushed per line so
    // consumers still see them in order.
    if (jsonl) {
      for (const c of checks) jsonl.write(checkToJsonl(runId, c));
    }

    const allIssues = checks.flatMap((c) => c.issues);

    currentPhase = "llm-aggregate";
    setSpinnerLabel(
      isLlmAvailable()
        ? `Agregando issues via LLM (${providerLabel()}, timeout=${llmTimeoutSec}s)…`
        : "Agregando issues (modo offline — sem LLM keys)…",
    );
    spinner.start();
    const llmHb = attachSpinnerHeartbeat(spinner, {
      baseText: isLlmAvailable()
        ? "Agregando issues via LLM (Sonnet 4.6)…"
        : "Agregando issues (modo offline)…",
    });
    const topIssues = await aggregateIssues({
      runId,
      prodUrl: opts.prod,
      candUrl: opts.cand,
      viewports,
      flows,
      checks,
      timeoutMs: llmTimeoutSec * 1000,
    });
    llmHb.stop();
    stampPhase("llm-aggregate");
    spinner.succeed(`${topIssues.length} issue(s) priorizada(s)`);
    currentPhase = "report";

    // Normalize the score over the number of paired (path × viewport)
    // captures — the unit issues multiply over. See src/engine/verdict.ts.
    const pagesAnalyzed = pairCaptures(checkCtx.prodPages, checkCtx.candPages).pairs.length;
    const verdict = computeVerdict(checks, allIssues, { pagesAnalyzed });

    // Score trend vs the last completed run against the same host pair.
    const prevRun = findPreviousRun(opts.output, {
      prodUrl: opts.prod,
      candUrl: opts.cand,
      excludeRunId: runId,
      scoreVersion: SCORE_VERSION,
    });
    const previousRun = prevRun
      ? { ...prevRun, scoreDelta: verdict.score - prevRun.score }
      : undefined;

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

    // Pull the structured visual-diff summary out of the visual-regression check
    const visualCheck = checks.find((c) => c.name === "visual-regression-keyframes");
    const visualDiff = visualCheck?.data?.visualDiff as VisualDiffSummary | undefined;
    // Pull the structured SEO summary out of the seo-deep-audit check
    const seoCheck = checks.find((c) => c.name === "seo-deep-audit");
    const seo = seoCheck?.data?.seo as SeoSummary | undefined;

    // Finalize timings BEFORE rendering the HTML so the report can show
    // the breakdown. The "report" phase itself (writes + render) is timed
    // separately below and patched into the JSON afterwards — the HTML
    // bar chart will list every phase except `report`, which is fine
    // since the report rendering is typically <100ms and not the user's
    // bottleneck. Review feedback on PR #60.
    const runTimings = timings.finalize();

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
      previousRun,
      topIssues,
      issues: allIssues,
      checks,
      flowCaptures: allFlowCaptures,
      visualDiff,
      seo,
      baseline: baselineSection,
      timings: runTimings,
    };

    const reportStart = performance.now();
    writeRunReportJson(paths.runDir, run);
    const html = renderHtmlReport(run, paths.runDir);
    writeRunReportHtml(paths.runDir, html);
    const reportDurationMs = performance.now() - reportStart;
    // Patch the JSON with the actual `report` phase duration so
    // consumers reading `report.json.timings` see all phases. The HTML
    // was already rendered above without it (acceptable trade-off).
    runTimings.phases.push({ phase: "report", durationMs: reportDurationMs });
    runTimings.totalMs += reportDurationMs;
    run.timings = runTimings;
    writeRunReportJson(paths.runDir, run);

    // Final JSONL record so consumers know the stream ended cleanly (#53).
    jsonl?.write({
      type: "complete",
      runId,
      totalDurationMs: Date.now() - startedAt,
      totalChecks: checks.length,
      totalIssues: allIssues.length,
      verdict: { status: verdict.status, score: verdict.score, scoreVersion: SCORE_VERSION },
    });

    printSummary(run, paths.reportHtml, { promotedCount, deprecatedCount, platform });
    console.log(`\n${formatTimingsSummary(runTimings, buildFlowBreakdown(allFlowCaptures))}`);

    if (opts.ci) {
      const blocking = allIssues.filter((i) => failOn.includes(i.severity));
      if (blocking.length > 0) {
        console.log(
          chalk.red(
            `\n  ✖ ${blocking.length} issue(s) bloqueante(s) [${failOn.join(", ")}] — exit 1`,
          ),
        );
        return 1;
      }
    }

    // --open: spin up a local proxy server (so the Side-by-side iframe works)
    // and block until the user Ctrl+C's. Must run AFTER Playwright cleanup.
    if (opts.open) {
      if (browser) {
        await browser.close().catch(() => undefined);
        browser = null;
      }
      return await serveRunAndBlock(paths.runDir, { label: `parity run · ${runId}` });
    }

    return 0;
  } catch (err) {
    spinner.fail(`Erro: ${(err as Error).message}`);
    console.error(err);
    // Emit a terminal error record so JSONL consumers can distinguish
    // "stream still going" from "crashed" without parsing exit codes
    // out-of-band. Review feedback on PR #64.
    jsonl?.write({
      type: "error",
      runId,
      message: (err as Error).message,
      durationMs: Date.now() - startedAt,
    });
    return 2;
  } finally {
    clearInterval(elapsedTicker);
    clearTimeout(globalTimeoutTimer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (browser) await browser.close().catch(() => undefined);
    jsonl?.close();
  }
}

/**
 * Build a partial Run object from whatever was collected so far. Issue #56:
 * used by SIGINT/SIGTERM/--timeout shutdown path so the user always gets a
 * report.html even after an interruption. Renderers should check `partial`
 * before showing pass/fail verdicts as authoritative.
 */
function buildPartialRun(args: {
  runId: string;
  timestamp: string;
  prodUrl: string;
  candUrl: string;
  flows: FlowName[];
  viewports: Viewport[];
  cep: string;
  startedAt: number;
  flowCaptures: FlowCapture[];
  checks: CheckResult[];
  partialReason: string;
  /** Snapshot of phase timings captured at shutdown. Review feedback on PR #60. */
  timings?: Run["timings"];
}): Run {
  const allIssues = args.checks.flatMap((c) => c.issues);
  const verdict = computeVerdict(args.checks, allIssues);
  return {
    schemaVersion: "0.1",
    id: args.runId,
    timestamp: args.timestamp,
    prodUrl: args.prodUrl,
    candUrl: args.candUrl,
    flows: args.flows,
    viewports: args.viewports,
    cep: args.cep,
    durationMs: Date.now() - args.startedAt,
    verdict,
    topIssues: [], // LLM aggregation didn't run
    issues: allIssues,
    checks: args.checks,
    flowCaptures: args.flowCaptures,
    partial: true,
    partialReason: args.partialReason,
    timings: args.timings,
  };
}

/**
 * Resolve the list of paths the user wants to visually compare.
 *  - `--pages-file` (when present) wins over `--pages`. One path per line,
 *    `#` starts a comment, empty lines are ignored.
 *  - `--pages` is a comma-separated list.
 *  - Returns `null` when neither flag is set (caller falls back to sitemap
 *    sampling).
 *
 * Paths are normalized: leading whitespace trimmed, missing leading "/"
 * prepended. We DO NOT validate against the prod site here — invalid paths
 * just yield 404 captures and surface as obvious diffs later.
 */
function resolveExplicitPages(
  pagesFile: string | undefined,
  pagesList: string | undefined,
): string[] | null {
  if (pagesFile) {
    if (!existsSync(pagesFile)) {
      throw new Error(`--pages-file não encontrado: ${pagesFile}`);
    }
    const raw = readFileSync(pagesFile, "utf-8");
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    return lines.map(normalizePath);
  }
  if (pagesList) {
    const parts = pagesList
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    return parts.map(normalizePath);
  }
  return null;
}

function normalizePath(p: string): string {
  return p.startsWith("/") ? p : `/${p}`;
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

interface PreflightResult {
  ok: boolean;
  errors: string[];
}

/**
 * Ping prod and cand before the heavy capture phase. Catches typos, dead URLs,
 * and obvious 5xx so we fail fast (3 seconds) instead of 10 minutes in.
 */
async function preflightCheck(
  prodUrl: string,
  candUrl: string,
  viewport: Viewport,
): Promise<PreflightResult> {
  const spinner = ora("Pre-flight: verificando URLs…").start();
  const errors: string[] = [];
  const ua = userAgentFor(viewport);

  // Use Playwright for probing so that sites behind JS challenges (e.g.
  // Cloudflare Managed Challenge / Turnstile) pass the pre-flight the same
  // way the real measurement passes do — the headless browser resolves the
  // JS challenge; a plain fetch always gets blocked by it.
  const browser = await launchBrowser({ headless: true }).catch(() => null);

  async function probeWithBrowser(label: string, url: string): Promise<void> {
    const ctx = await browser!.newContext({
      userAgent: ua,
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();
    try {
      const res = await page.goto(url, { waitUntil: "commit", timeout: 30_000 });
      const status = res?.status() ?? 0;
      if (status >= 500) errors.push(`${label}: HTTP ${status} (${url})`);
      // 4xx via Playwright means the origin genuinely rejects the request —
      // JS challenges always resolve to 2xx in a real browser
      else if (status >= 400) errors.push(`${label}: HTTP ${status} (${url})`);
    } catch (err) {
      const e = err as Error;
      errors.push(`${label}: ${e.message.split("\n")[0]} (${url})`);
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  async function probeWithFetch(label: string, url: string): Promise<void> {
    // Fallback when Playwright is not available (PARITY_SKIP_PLAYWRIGHT_INSTALL=1
    // or the binary download failed). Best-effort — JS-challenge sites will
    // still return 403 here, but that's better than crashing.
    const PREFLIGHT_TIMEOUT_MS = 30_000;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": ua },
      });
      if (res.status >= 500) errors.push(`${label}: HTTP ${res.status} ${res.statusText} (${url})`);
      else if (res.status >= 400)
        errors.push(`${label}: HTTP ${res.status} ${res.statusText} (${url})`);
    } catch (err) {
      const e = err as Error;
      const msg = e.name === "AbortError" ? `timeout (${PREFLIGHT_TIMEOUT_MS / 1000}s)` : e.message;
      errors.push(`${label}: ${msg} (${url})`);
    } finally {
      clearTimeout(t);
    }
  }

  async function probe(label: string, url: string): Promise<void> {
    try {
      new URL(url);
    } catch {
      errors.push(`${label}: URL inválida (${url})`);
      return;
    }
    if (browser) {
      await probeWithBrowser(label, url);
    } else {
      await probeWithFetch(label, url);
    }
  }

  await Promise.all([probe("prod", prodUrl), probe("cand", candUrl)]);
  await browser?.close().catch(() => {});

  if (errors.length > 0) {
    spinner.fail("Pre-flight falhou");
    return { ok: false, errors };
  }
  spinner.succeed("Pre-flight OK");
  return { ok: true, errors: [] };
}

/**
 * Append a unique `?_pcb=<ts>` query so CF/CDN treat the request as a unique
 * key, forcing the origin worker to serve a fresh response. Preserves any
 * existing query string and fragment.
 */
function addCacheBuster(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("_pcb", String(Date.now()));
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Pre-flight warmup: hit each target once per viewport with a cache-buster
 * and `Cache-Control: no-cache`. The worker is forced to render a fresh
 * response and any device-segmented cache buckets get populated with the
 * current deploy. Avoids the "deploy → parity sees stale" loop.
 */
interface WarmupResult {
  attempted: number;
  succeeded: number;
  failed: Array<{ url: string; viewport: Viewport; reason: string }>;
}

async function warmupTargets(opts: {
  urls: string[];
  viewports: Viewport[];
  bypassCache: boolean;
}): Promise<WarmupResult> {
  const headers: Record<string, string> = opts.bypassCache
    ? { "Cache-Control": "no-cache", Pragma: "no-cache" }
    : {};
  type Outcome = { ok: true } | { ok: false; url: string; viewport: Viewport; reason: string };
  const jobs: Array<Promise<Outcome>> = [];
  for (const url of opts.urls) {
    for (const viewport of opts.viewports) {
      // Use the same per-viewport UA the browser will send (issue #25),
      // so the warmup populates the device-segmented cache bucket the
      // measurement loop will actually read from.
      const ua = userAgentFor(viewport);
      const target = addCacheBuster(url);
      jobs.push(
        fetch(target, {
          method: "GET",
          redirect: "follow",
          headers: { ...headers, "User-Agent": ua },
        })
          .then(
            (res): Outcome =>
              res.ok || (res.status >= 200 && res.status < 400)
                ? { ok: true }
                : { ok: false, url, viewport, reason: `HTTP ${res.status} ${res.statusText}` },
          )
          .catch(
            (err): Outcome => ({
              ok: false,
              url,
              viewport,
              reason: (err as Error).message ?? "fetch failed",
            }),
          ),
      );
    }
  }
  const results = await Promise.all(jobs);
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results
    .filter((r): r is Extract<Outcome, { ok: false }> => !r.ok)
    .map(({ url, viewport, reason }) => ({ url, viewport, reason }));
  return { attempted: results.length, succeeded, failed };
}

async function fetchHomeHtml(url: string, viewport: Viewport = "desktop"): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": userAgentFor(viewport),
        Accept: "text/html,application/xhtml+xml",
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

function findPdpCapture(flows: FlowCapture[], side: Side): PageCapture | undefined {
  for (const fc of flows) {
    if (fc.side !== side) continue;
    if (fc.flow !== "purchase-journey" && fc.flow !== "pdp") continue;
    // PDP is the last page in the flow
    const last = fc.pages[fc.pages.length - 1];
    if (last) return last;
  }
  return undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function printSummary(
  run: Run,
  htmlPath: string,
  meta: { promotedCount: number; deprecatedCount: number; platform: Platform },
): void {
  const { verdict } = run;
  const emoji =
    verdict.status === "pass"
      ? chalk.green("✔")
      : verdict.status === "warn"
        ? chalk.yellow("⚠")
        : chalk.red("✖");
  const score =
    verdict.status === "pass"
      ? chalk.green(verdict.score)
      : verdict.status === "warn"
        ? chalk.yellow(verdict.score)
        : chalk.red(verdict.score);

  const prev = run.previousRun;
  const scoreDelta = !prev
    ? chalk.dim("  (sem run anterior comparável)")
    : prev.scoreDelta > 0
      ? chalk.green(`  (+${prev.scoreDelta} vs run anterior: ${prev.score})`)
      : prev.scoreDelta < 0
        ? chalk.red(`  (${prev.scoreDelta} vs run anterior: ${prev.score})`)
        : chalk.dim(`  (= run anterior: ${prev.score})`);

  console.log("");
  console.log(
    `  ${emoji}  parity ${verdict.status.toUpperCase()} · score ${score}/100${scoreDelta}`,
  );
  console.log(
    `     checks: ${chalk.green(verdict.checksPassed)} pass · ${chalk.red(verdict.checksFailed)} fail · ${chalk.dim(`${verdict.checksSkipped} skipped`)}`,
  );
  console.log(
    `     issues: ${chalk.red(verdict.critical)} critical · ${chalk.yellow(verdict.high)} high · ${verdict.medium} medium · ${chalk.dim(`${verdict.low} low`)}`,
  );
  if (run.visualDiff) {
    const vd = run.visualDiff;
    const parityIcon = vd.parityOk ? chalk.green("✔") : chalk.red("✖");
    const parityLabel = vd.parityOk ? chalk.green("OK") : chalk.red("DIFFS");
    const cacheNote = vd.pagesFromCache > 0 ? chalk.dim(` · ${vd.pagesFromCache} cached`) : "";
    console.log(
      `     visual: ${parityIcon} parityOk=${parityLabel} · ${vd.pagesChecked} pages · ${chalk.red(vd.pagesWithDiffs)} diffs · ${chalk.green(vd.pagesPassed)} pass${cacheNote}`,
    );
  }
  if (run.topIssues.length > 0) {
    console.log("");
    console.log(chalk.bold("  Top issues:"));
    for (const g of groupIssues(run.topIssues).slice(0, 5)) {
      const i = g.sample;
      const sev =
        i.severity === "critical"
          ? chalk.red(`[${i.severity}]`)
          : i.severity === "high"
            ? chalk.yellow(`[${i.severity}]`)
            : chalk.dim(`[${i.severity}]`);
      const pagesNote = g.pages.length > 1 ? chalk.dim(` (${g.pages.length} páginas)`) : "";
      console.log(`     ${sev} ${i.summary}${pagesNote}`);
    }
  }
  if (meta.promotedCount > 0 || meta.deprecatedCount > 0) {
    console.log("");
    console.log(
      chalk.dim(
        `  📚 learned-selectors [${meta.platform}]: ${chalk.green(`+${meta.promotedCount}`)} promoted · ${chalk.yellow(meta.deprecatedCount)} deprecated`,
      ),
    );
  }
  console.log("");
  console.log(chalk.dim(`  → ${htmlPath}`));
  console.log("");
}
