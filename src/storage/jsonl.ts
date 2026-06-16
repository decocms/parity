import { closeSync, openSync, writeSync, type WriteStream } from "node:fs";
import type { CheckResult, Issue } from "../types/schema.ts";

/**
 * JSON-Lines writer for streaming check results to agents/scripts.
 * Issue #53: today the HTML report is the only consumable surface, which
 * means agents (Claude Code etc.) have to scrape HTML or wait for the
 * full run before parsing. JSONL lets each check be consumed as soon as
 * it completes, with a stable per-line schema.
 *
 * The writer supports two targets:
 *   - file path → opened with `openSync`, flushed on every `write()`
 *   - "-"       → stdout, useful for `parity run --json - | jq` pipelines
 *
 * Schema is versioned via the leading metadata line so future
 * non-backwards-compatible additions can be detected by consumers.
 */
export interface JsonlMetadata {
  schemaVersion: "1.0";
  runId: string;
  prodUrl: string;
  candUrl: string;
  flows: string[];
  viewports: string[];
  timestamp: string;
}

export interface JsonlCheckRecord {
  type: "check";
  runId: string;
  check: string;
  status: CheckResult["status"];
  severity: CheckResult["severity"];
  durationMs: number;
  summary: string;
  issueCount: number;
  issues: Array<Pick<Issue, "id" | "severity" | "category" | "summary" | "page" | "check">>;
}

export interface JsonlFinalRecord {
  type: "complete";
  runId: string;
  totalDurationMs: number;
  totalChecks: number;
  totalIssues: number;
  verdict: { status: "pass" | "warn" | "fail"; score: number };
}

export type JsonlRecord = JsonlMetadata | JsonlCheckRecord | JsonlFinalRecord;

export class JsonlWriter {
  private fd: number | null = null;
  private readonly target: "stdout" | "file";

  constructor(pathOrDash: string) {
    if (pathOrDash === "-") {
      this.target = "stdout";
    } else {
      this.target = "file";
      this.fd = openSync(pathOrDash, "w");
    }
  }

  write(record: JsonlRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    if (this.target === "stdout") {
      process.stdout.write(line);
    } else if (this.fd !== null) {
      writeSync(this.fd, line);
    }
  }

  close(): void {
    if (this.target === "file" && this.fd !== null) {
      try {
        closeSync(this.fd);
      } finally {
        this.fd = null;
      }
    }
  }
}

/** Build the per-check JSONL record from a `CheckResult`. */
export function checkToJsonl(runId: string, check: CheckResult): JsonlCheckRecord {
  return {
    type: "check",
    runId,
    check: check.name,
    status: check.status,
    severity: check.severity,
    durationMs: check.durationMs,
    summary: check.summary,
    issueCount: check.issues.length,
    issues: check.issues.map((i) => ({
      id: i.id,
      severity: i.severity,
      category: i.category,
      summary: i.summary,
      page: i.page,
      check: i.check,
    })),
  };
}
