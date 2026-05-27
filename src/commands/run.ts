import { join } from "node:path";
import chalk from "chalk";
import ora from "ora";
import type { Browser } from "playwright";
import { runAllChecks } from "../checks/index.ts";
import type { CheckContext } from "../checks/index.ts";
import { launchBrowser, newContext, stopTracing } from "../engine/browser.ts";
import { capturePage, installVitalsCollector } from "../engine/collect.ts";
import { runFlow } from "../engine/flows.ts";
import { discoverPagesFromSitemap } from "../engine/sitemap-discover.ts";
import { resolveSitemapUrls } from "../diff/sitemap.ts";
import { loadParityIgnore, loadParityRc } from "../ignore/parser.ts";
import { detectPlatform, type Platform } from "../learned/platform.ts";
import { promoteStepsFromFlow } from "../learned/promote.ts";
import {
  type LearnedSelectors,
  loadLearned,
  saveLearned,
} from "../learned/repo.ts";
import { aggregateIssues } from "../llm/aggregate-issues.ts";
import { isLlmAvailable } from "../llm/client.ts";
import { discoverSelectorsFromUrl } from "../llm/discover-selectors.ts";
import { fingerprintPdp, matchPdps } from "../llm/match-pdp.ts";
import { renderHtmlReport } from "../report/render.ts";
import { serveRunAndBlock } from "./serve.ts";
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
  SeoSummary,
  Side,
  Verdict,
  VisualDiffSummary,
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
  /** When false, don't write to learned-selectors.json (read-only mode) */
  learn?: boolean;
  /** Extra pages (beyond flows) to crawl just for Web Vitals coverage. Default 10. */
  vitalsPages?: number;
  /** Pages to compare visually (prod vs cand screenshots + LLM). Default 5. */
  visualPages?: number;
  /** Disable the visual-diff capture pass entirely. */
  noVisualDiff?: boolean;
  /** Named bundle of defaults. Individual flags still override the preset. */
  preset?: "smoke" | "full" | "ci";
}

type PresetDefaults = Partial<Pick<RunOptions,
  | "flows"
  | "viewports"
  | "vitalsPages"
  | "visualPages"
  | "noVisualDiff"
  | "autoSelectors"
>>;

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
  // Full audit — purchase journey, both viewports, visual diff, extra vitals
  full: {
    flows: "purchase-journey",
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

export async function runCommand(rawOpts: RunOptions): Promise<number> {
  const opts = applyPreset(rawOpts);
  if (rawOpts.preset) {
    console.log(chalk.dim(`  preset: ${rawOpts.preset}`));
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

  // Pre-flight: confirm both URLs respond before spending 10 minutes on a doomed run
  const preflight = await preflightCheck(opts.prod, opts.cand);
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
  const prodHomeHtml = await fetchHomeHtml(opts.prod);
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
      const html = prodHomeHtml ?? (await fetchHomeHtml(opts.prod));
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
            learned,
            platform,
            recoveryBudget: 3,
          });
          allFlowCaptures.push(cap);
          for (const p of cap.pages) allPageCaptures.push(p);

          // Promotion loop: update learned-selectors from this flow's outcomes
          if (opts.learn !== false) {
            const result = promoteStepsFromFlow(learned, platform, prodHost, cap);
            promotedCount += result.promoted;
            deprecatedCount += result.deprecated;
          }
        }

        await stopTracing(ctx, tracePath).catch(() => undefined);
        await ctx.close();
      }
    }
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

    // Extra vitals coverage: crawl additional pages from sitemap to enrich the Vitals tab
    const vitalsPagesLimit = opts.vitalsPages ?? 10;
    if (browser && vitalsPagesLimit > 0) {
      const extraSpinner = ora("Coletando vitals em páginas extras…").start();
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
        while (extraPaths.length < vitalsPagesLimit && keys.some((k) => (buckets.get(k)?.length ?? 0) > 0)) {
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
            try {
              const ctx = await newContext(browser!, { viewport: task.viewport, cohortCookieValue: "control" });
              await installVitalsCollector(ctx);
              const page = await ctx.newPage();
              try {
                const cap = await capturePage(page, {
                  url: fullUrl,
                  side: task.side,
                  viewport: task.viewport,
                  screenshotPath: `${paths.screenshotsDir}/extra-${task.path.replace(/[/?&=]+/g, "_")}-${task.viewport}-${task.side}.png`,
                  settleMs: 1200,
                  timeoutMs: 20_000,
                  fast: true,
                  scrollToLoad: false,
                  skipScreenshot: true,
                });
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
              extraSpinner.text = `[vitals extras] ${done}/${tasks.length} (último: ${task.path})`;
            }
          });
          extraSpinner.succeed(`+${extraPaths.length} página(s) com vitals`);
        } else {
          extraSpinner.warn("Nenhuma página extra encontrada no sitemap");
        }
      } catch (err) {
        extraSpinner.warn(`vitals extras pulado: ${(err as Error).message}`);
      }
    }

    // Visual diff capture pass: home + sampled PLPs/PDPs from sitemap, with full-page screenshots
    const visualPagesLimit = opts.noVisualDiff ? 0 : (opts.visualPages ?? 5);
    if (browser && visualPagesLimit > 0) {
      const visualSpinner = ora("Descobrindo páginas pra visual diff…").start();
      try {
        const sample = await discoverPagesFromSitemap(opts.prod, { sampleSize: visualPagesLimit });
        const visualPaths = sample.all.map((p) => p.path);
        // Don't re-capture paths we already have screenshots for (in flows or vitals extras)
        const alreadyCapturedKeys = new Set<string>();
        for (const p of allPageCaptures) {
          try {
            alreadyCapturedKeys.add(`${new URL(p.url).pathname}::${p.viewport}::${p.side}`);
          } catch {
            /* skip */
          }
        }

        const tasks: Array<{ path: string; viewport: Viewport; side: Side }> = [];
        for (const viewport of viewports) {
          for (const path of visualPaths) {
            for (const side of ["prod", "cand"] as Side[]) {
              if (alreadyCapturedKeys.has(`${path}::${viewport}::${side}`)) continue;
              tasks.push({ path, viewport, side });
            }
          }
        }

        if (tasks.length === 0) {
          visualSpinner.succeed(`Visual diff: páginas já capturadas em flows (${visualPaths.length} alvos)`);
        } else {
          visualSpinner.text = `Visual diff: capturando ${tasks.length} screenshot(s) (${visualPaths.length} páginas × ${viewports.length} viewport(s) × 2 sides)…`;
          let done = 0;
          await runWithConcurrency(tasks, 4, async (task) => {
            const baseUrl = task.side === "prod" ? opts.prod : opts.cand;
            const fullUrl = new URL(task.path, baseUrl).toString();
            const safePath = task.path.replace(/[/?&=]+/g, "_") || "_root";
            const screenshotPath = `${paths.screenshotsDir}/visual-${safePath}-${task.viewport}-${task.side}.png`;
            try {
              const ctx = await newContext(browser!, { viewport: task.viewport, cohortCookieValue: "control" });
              await installVitalsCollector(ctx);
              const page = await ctx.newPage();
              try {
                const cap = await capturePage(page, {
                  url: fullUrl,
                  side: task.side,
                  viewport: task.viewport,
                  screenshotPath,
                  settleMs: 1800,
                  timeoutMs: 30_000,
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
              visualSpinner.text = `[visual] ${done}/${tasks.length} (último: ${task.path})`;
            }
          });
          visualSpinner.succeed(`Visual diff: ${tasks.length} screenshot(s) capturado(s)`);
        }
      } catch (err) {
        visualSpinner.warn(`Visual diff descoberta pulada: ${(err as Error).message}`);
      }
    }

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

    // Pull the structured visual-diff summary out of the visual-regression check
    const visualCheck = checks.find((c) => c.name === "visual-regression-keyframes");
    const visualDiff = (visualCheck?.data?.visualDiff as VisualDiffSummary | undefined);
    // Pull the structured SEO summary out of the seo-deep-audit check
    const seoCheck = checks.find((c) => c.name === "seo-deep-audit");
    const seo = (seoCheck?.data?.seo as SeoSummary | undefined);

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
      visualDiff,
      seo,
      baseline: baselineSection,
    };

    writeRunReportJson(paths.runDir, run);
    const html = renderHtmlReport(run, paths.runDir);
    writeRunReportHtml(paths.runDir, html);

    printSummary(run, paths.reportHtml, { promotedCount, deprecatedCount, platform });

    if (opts.ci) {
      const blocking = allIssues.filter((i) => failOn.includes(i.severity));
      if (blocking.length > 0) {
        console.log(
          chalk.red(`\n  ✖ ${blocking.length} issue(s) bloqueante(s) [${failOn.join(", ")}] — exit 1`),
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
async function preflightCheck(prodUrl: string, candUrl: string): Promise<PreflightResult> {
  const spinner = ora("Pre-flight: verificando URLs…").start();
  const errors: string[] = [];

  async function probe(label: string, url: string): Promise<void> {
    try {
      new URL(url);
    } catch {
      errors.push(`${label}: URL inválida (${url})`);
      return;
    }
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        },
      });
      if (res.status >= 500) errors.push(`${label}: HTTP ${res.status} ${res.statusText} (${url})`);
      else if (res.status >= 400) errors.push(`${label}: HTTP ${res.status} ${res.statusText} (${url})`);
    } catch (err) {
      const e = err as Error;
      const msg = e.name === "AbortError" ? "timeout (10s)" : e.message;
      errors.push(`${label}: ${msg} (${url})`);
    } finally {
      clearTimeout(t);
    }
  }

  await Promise.all([probe("prod", prodUrl), probe("cand", candUrl)]);

  if (errors.length > 0) {
    spinner.fail("Pre-flight falhou");
    return { ok: false, errors };
  }
  spinner.succeed("Pre-flight OK");
  return { ok: true, errors: [] };
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
