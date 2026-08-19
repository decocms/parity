// Standalone prod-vs-candidate vitals benchmark, built for the FARM Rio
// Fresh/deco.cx -> TanStack Start migration but reusable as a template for
// any prod/candidate pair: point HOSTS/ALL_PATHS elsewhere and it works the
// same way. Not a CLI feature — a script you run with `npx tsx` and env vars.
//
// Two independent measurement paths, either or both:
//   - parity's own capturePage()/vitals collector (real browser, in-process)
//   - Lighthouse, spawned fresh per run, real (not simulated) mobile
//     throttling (Slow 4G + 4x CPU) via --throttling-method=devtools
//
// Grew out of a validation spike asking "is parity's own vitals capture
// trustworthy enough to benchmark a migration candidate with?" — cross-
// checking it against Lighthouse surfaced two real bugs, both fixed:
//   - decocms/parity#179 -> #180: --runs was declared but never implemented
//   - decocms/parity#182 -> #183: CLS was a lifetime sum, not the spec's
//     max-session-window
// and explained one real methodology gap, also fixed:
//   - decocms/parity#186: parity's TTFB/FCP/LCP measure a warm-connection,
//     cache-enabled scenario by default — genuinely different from
//     Lighthouse's cold-first-visit simulation, not a bug in either tool.
// Still open: decocms/parity#190 (a reproducible parity/Lighthouse CLS miss
// on one specific page, and a suspiciously flat prod TTFB pattern that
// survived the #186 fix — not yet root-caused).
//
// Usage:
//   cd parity && npx tsx scripts/farmrio-vitals-check.ts
//
// Env vars:
//   RUNS=5            samples per page per host per tool (default 5)
//   SMOKE=1           1 host, 1 path, 1 run — sanity-check the pipeline fast
//   SKIP_PARITY=1     Lighthouse only, skip parity's own capture entirely
//   ONLY_HOST=prod    scope to one host (name from HOSTS below)
//   ONLY_PATH=/bazar  scope to one path (must exactly match an ALL_PATHS entry)
//   OUT_DIR=<path>    where raw.json/summary.json/lighthouse/*.json land
//                     (default: ./vitals-check-output, gitignored)
//
// Findings and full per-run data from actually running this against FARM
// Rio: see the linked issues above and the reports referenced from them.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, newContext } from "../src/engine/browser.ts";
import { capturePage, installVitalsCollector } from "../src/engine/collect.ts";
// Productized form of this spike: `parity benchmark --prod <url> --cand <url>`
// (src/commands/benchmark.ts) — a parameterized user-navigation benchmark that
// reuses this same Lighthouse runner.
import { type LhSample, measureLighthouse } from "../src/engine/lighthouse.ts";

const SMOKE = process.env.SMOKE === "1";
const RUNS = SMOKE ? 1 : process.env.RUNS ? Number(process.env.RUNS) : 5;
const VIEWPORT = "mobile" as const;
const OUT_DIR = process.env.OUT_DIR ?? "./vitals-check-output";

const ALL_HOSTS = [
  { name: "prod", side: "prod" as const, base: "https://www.farmrio.com.br" },
  { name: "candidate", side: "cand" as const, base: "https://farmrio-tanstack.deco.site" },
];
const HOSTS = process.env.ONLY_HOST
  ? ALL_HOSTS.filter((h) => h.name === process.env.ONLY_HOST)
  : ALL_HOSTS;

// The migration's pinned hot-page set: home, 2 category listings, 2 product
// pages, 1 campaign listing — picked to cover the main page types, not an
// exhaustive crawl.
const ALL_PATHS = [
  "/",
  "/bazar",
  "/farm-etc",
  "/vestido-cropped-estampado-flor-do-deserto-flor-do-deserto_bg-seda-366654-57798/p",
  "/t-shirt-fit-pilha-de-pranchas-off-white-369915-07448/p",
  "/produtos/tendencias",
];
const PATHS = SMOKE ? ["/"] : process.env.ONLY_PATH ? [process.env.ONLY_PATH] : ALL_PATHS;
const SKIP_PARITY = process.env.SKIP_PARITY === "1";

interface VitalsSample {
  lcp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
  inp: number | null;
  status: number;
  durationMs: number;
}

interface ResultRow {
  host: string;
  path: string;
  run: number;
  parity: VitalsSample | { error: string };
  lighthouse: LhSample | { error: string };
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(join(OUT_DIR, "lighthouse"), { recursive: true });
const unusedScreenshot = join(OUT_DIR, "unused.png");

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

/**
 * Warm exactly one host+path, immediately before it's measured — not once
 * upfront for everything. A Worker isolate (or an edge cache entry) can go
 * cold/stale within roughly a minute of inactivity; a single warmup pass at
 * the start of the script is useless by the time later paths get measured
 * (a full 6-path x 3-run prod pass alone takes ~20min under real
 * throttling), and even consecutive same-page runs are ~1-2min apart. So:
 * warm right before every single measurement, every run.
 *
 * Fully self-contained (launches and closes its own browser) rather than
 * reusing a shared long-lived instance: a Playwright Chromium left resident
 * for the whole run sits alongside Lighthouse's own separately-launched
 * Chrome during its devtools-throttled measurement. Real CPU throttling
 * (--throttling-method=devtools) slows the *actual* CPU, so any competing
 * process on the same machine gets proportionally amplified in the results
 * — this was corrupting Total Blocking Time into the 10-20+ second range
 * before isolating it.
 */
async function warmupOne(host: (typeof HOSTS)[number], path: string): Promise<void> {
  const browser = await launchBrowser({ headless: true });
  try {
    const ctx = await newContext(browser, { viewport: VIEWPORT });
    const page = await ctx.newPage();
    try {
      await capturePage(page, {
        url: new URL(path, host.base).toString(),
        side: host.side,
        viewport: VIEWPORT,
        screenshotPath: unusedScreenshot,
        skipScreenshot: true,
        fast: true,
        settleMs: 500,
        timeoutMs: 45_000,
        scrollToLoad: false,
      });
    } catch (err) {
      log(`  warmup FAILED ${host.name}${path}: ${(err as Error).message}`);
    } finally {
      await page.close().catch(() => undefined);
      await ctx.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function measureParity(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  host: (typeof HOSTS)[number],
  path: string,
): Promise<VitalsSample | { error: string }> {
  const ctx = await newContext(browser, { viewport: VIEWPORT });
  await installVitalsCollector(ctx);
  const page = await ctx.newPage();
  try {
    const cap = await capturePage(page, {
      url: new URL(path, host.base).toString(),
      side: host.side,
      viewport: VIEWPORT,
      screenshotPath: unusedScreenshot,
      skipScreenshot: true,
      fast: false,
      settleMs: 1500,
      timeoutMs: 45_000,
      scrollToLoad: true,
    });
    return { ...cap.vitals, status: cap.status, durationMs: cap.durationMs };
  } catch (err) {
    return { error: (err as Error).message };
  } finally {
    await page.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stats(
  values: number[],
): { median: number; p75: number; min: number; max: number; n: number } | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  // Non-null: clean.length > 0 is already checked above, so every index
  // below is in bounds despite noUncheckedIndexedAccess.
  const pct = (p: number) =>
    clean[Math.min(clean.length - 1, Math.ceil((p / 100) * clean.length) - 1)]!;
  return {
    median: pct(50),
    p75: pct(75),
    min: clean[0]!,
    max: clean[clean.length - 1]!,
    n: clean.length,
  };
}

async function main(): Promise<void> {
  log(`starting — ${HOSTS.length} hosts x ${PATHS.length} paths x ${RUNS} runs x 2 tools`);
  // Only kept open across the run when parity itself is being measured.
  // warmupOne is self-contained (own browser per call) specifically so
  // nothing sits resident alongside Lighthouse's devtools-throttled Chrome.
  const browser = SKIP_PARITY ? null : await launchBrowser({ headless: true });
  const rows: ResultRow[] = [];
  try {
    for (const host of HOSTS) {
      for (const path of PATHS) {
        for (let run = 1; run <= RUNS; run++) {
          log(`warming  ${host.name}${path} [run ${run}/${RUNS}]`);
          await warmupOne(host, path);

          let parity: VitalsSample | { error: string } = { error: "skipped (SKIP_PARITY=1)" };
          if (!SKIP_PARITY && browser) {
            log(`measuring ${host.name}${path} [parity run ${run}/${RUNS}]`);
            parity = await measureParity(browser, host, path);
          }
          log(`measuring ${host.name}${path} [lighthouse run ${run}/${RUNS}]`);
          // Short id, not the full slug: long product-slug paths pushed the
          // combined output-path past Windows' MAX_PATH (silent ENOENT).
          const lighthouse = await measureLighthouse(new URL(path, host.base).toString(), {
            outDir: join(OUT_DIR, "lighthouse"),
            id: `${host.name}-p${ALL_PATHS.indexOf(path)}-run${run}`,
            formFactor: "mobile",
          });
          rows.push({ host: host.name, path, run, parity, lighthouse });
          await sleep(500);
        }
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
  }

  writeFileSync(join(OUT_DIR, "raw.json"), JSON.stringify(rows, null, 2));

  // Aggregate per host/path/tool/metric.
  const summary: Record<string, unknown> = {};
  for (const host of HOSTS) {
    for (const path of PATHS) {
      const key = `${host.name}${path}`;
      const subset = rows.filter((r) => r.host === host.name && r.path === path);
      const parityOk = subset
        .map((r) => r.parity)
        .filter((v): v is VitalsSample => !("error" in v));
      const lhOk = subset.map((r) => r.lighthouse).filter((v): v is LhSample => !("error" in v));
      const metricStats = <T extends VitalsSample | LhSample>(arr: T[], metric: keyof T) =>
        stats(
          (arr.map((v) => v[metric]) as unknown[]).filter(
            (v): v is number => typeof v === "number",
          ),
        );
      summary[key] = {
        parity: {
          errors: subset.length - parityOk.length,
          lcp: metricStats(parityOk, "lcp"),
          cls: metricStats(parityOk, "cls"),
          fcp: metricStats(parityOk, "fcp"),
          ttfb: metricStats(parityOk, "ttfb"),
          inp: metricStats(parityOk, "inp"),
        },
        lighthouse: {
          errors: subset.length - lhOk.length,
          lcp: metricStats(lhOk, "lcp"),
          cls: metricStats(lhOk, "cls"),
          fcp: metricStats(lhOk, "fcp"),
          ttfb: metricStats(lhOk, "ttfb"),
          tbt: metricStats(lhOk, "tbt"),
        },
      };
    }
  }
  writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  log(`done — raw.json + summary.json written to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
