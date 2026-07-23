import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Run } from "../types/schema.ts";

export interface RunPaths {
  runDir: string;
  reportJson: string;
  reportHtml: string;
  screenshotsDir: string;
  harDir: string;
  tracesDir: string;
  consoleDir: string;
  runLog: string;
}

export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "T");
}

export function createRunDir(outputDir: string, runId: string): RunPaths {
  const runDir = join(outputDir, "runs", runId);
  const paths: RunPaths = {
    runDir,
    reportJson: join(runDir, "report.json"),
    reportHtml: join(runDir, "report.html"),
    screenshotsDir: join(runDir, "screenshots"),
    harDir: join(runDir, "har"),
    tracesDir: join(runDir, "traces"),
    consoleDir: join(runDir, "console"),
    runLog: join(runDir, "run.log"),
  };
  for (const dir of [
    paths.runDir,
    paths.screenshotsDir,
    paths.harDir,
    paths.tracesDir,
    paths.consoleDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function getRunPaths(outputDir: string, runId: string): RunPaths {
  const runDir = join(outputDir, "runs", runId);
  return {
    runDir,
    reportJson: join(runDir, "report.json"),
    reportHtml: join(runDir, "report.html"),
    screenshotsDir: join(runDir, "screenshots"),
    harDir: join(runDir, "har"),
    tracesDir: join(runDir, "traces"),
    consoleDir: join(runDir, "console"),
    runLog: join(runDir, "run.log"),
  };
}

export function writeRunReportJson(runDir: string, run: Run): string {
  const path = join(runDir, "report.json");
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return path;
}

export function writeRunReportHtml(runDir: string, html: string): string {
  const path = join(runDir, "report.html");
  writeFileSync(path, html, "utf8");
  return path;
}

export function loadRun(outputDir: string, runId: string): Run {
  const reportJson = join(outputDir, "runs", runId, "report.json");
  if (!existsSync(reportJson)) {
    throw new Error(`Run not found: ${runId}`);
  }
  const raw = JSON.parse(readFileSync(reportJson, "utf8"));
  return Run.parse(raw);
}

/**
 * Most recent completed run against the same prod/cand host pair — used
 * to show the score trend ("score 64 (+23 vs previous run)").
 *
 * Reads report.json raw (NOT `Run.parse`) so reports written by older
 * CLI versions never throw here. Skips partial runs (their verdict is
 * not authoritative) and runs whose `verdict.scoreVersion` differs from
 * the requested one, so the first run after a formula upgrade shows "no
 * comparable previous run" instead of a bogus delta against the old scale.
 */
/** Sorted-array set equality — order-independent, dedup-independent. */
function sameModuleSet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const m of setA) if (!setB.has(m)) return false;
  return true;
}

export function findPreviousRun(
  outputDir: string,
  opts: {
    prodUrl: string;
    candUrl: string;
    excludeRunId?: string;
    scoreVersion?: number;
    /**
     * Module names (M3 module scoring) the CURRENT run scored. When
     * provided, a candidate previous run is only considered comparable if
     * its own module set matches exactly — a run scored on `--only e2e`
     * alone isn't apples-to-apples with a full run's composite score.
     * When omitted (legacy/no-module runs), no module filtering happens —
     * today's host+scoreVersion behavior is preserved.
     */
    modulesRun?: string[];
  },
): { id: string; timestamp: string; score: number } | null {
  const hostOf = (url: string): string => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };
  const prodHost = hostOf(opts.prodUrl);
  const candHost = hostOf(opts.candUrl);
  for (const entry of listRuns(outputDir)) {
    if (entry.id === opts.excludeRunId) continue;
    try {
      const raw = JSON.parse(readFileSync(entry.reportPath, "utf8")) as {
        id?: string;
        timestamp?: string;
        prodUrl?: string;
        candUrl?: string;
        partial?: boolean;
        verdict?: { score?: number; scoreVersion?: number; modulesRun?: string[] };
      };
      if (raw.partial) continue;
      if (typeof raw.verdict?.score !== "number") continue;
      if (opts.scoreVersion !== undefined && raw.verdict.scoreVersion !== opts.scoreVersion)
        continue;
      if (hostOf(raw.prodUrl ?? "") !== prodHost || hostOf(raw.candUrl ?? "") !== candHost)
        continue;
      if (opts.modulesRun && opts.modulesRun.length > 0) {
        const candidateModules = raw.verdict?.modulesRun ?? [];
        if (!sameModuleSet(candidateModules, opts.modulesRun)) continue;
      }
      return {
        id: raw.id ?? entry.id,
        timestamp: raw.timestamp ?? entry.timestamp,
        score: raw.verdict.score,
      };
    } catch {
      /* unreadable report — skip */
    }
  }
  return null;
}

export function listRuns(
  outputDir: string,
): { id: string; timestamp: string; reportPath: string }[] {
  const runsDir = join(outputDir, "runs");
  if (!existsSync(runsDir)) return [];
  const entries = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const reportPath = join(runsDir, e.name, "report.json");
      let timestamp = e.name;
      try {
        if (existsSync(reportPath)) {
          const r = JSON.parse(readFileSync(reportPath, "utf8")) as { timestamp?: string };
          if (r.timestamp) timestamp = r.timestamp;
        }
      } catch {
        /* ignore parse errors */
      }
      return { id: e.name, timestamp, reportPath };
    })
    .sort((a, b) => b.id.localeCompare(a.id));
  return entries;
}
