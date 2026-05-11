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
  for (const dir of [paths.runDir, paths.screenshotsDir, paths.harDir, paths.tracesDir, paths.consoleDir]) {
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

export function listRuns(outputDir: string): { id: string; timestamp: string; reportPath: string }[] {
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
