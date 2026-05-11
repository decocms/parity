import { diffConsole } from "../diff/console.ts";
import type { CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

export function consoleErrorsBaseline(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);
  const issues: Issue[] = [];
  let totalNew = 0;

  for (const pair of pairs) {
    const diff = diffConsole(pair.prod.console, pair.cand.console, {
      ignorePatterns: ctx.ignore.ignoreConsolePatterns,
      errorsOnly: true,
    });
    totalNew += diff.newInCand.length;
    for (const e of diff.newInCand) {
      issues.push({
        id: `console:${pair.key}:${hash(e.key)}`,
        severity: e.cls === "hydration" ? "critical" : "high",
        category: "console",
        page: pair.key,
        check: "console-errors-baseline",
        summary: `[${e.cls}] novo erro de console em ${pair.key}: ${truncate(e.entry.text, 160)}`,
        details: e.entry.text,
        evidence: [{ kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" }],
      });
    }
  }

  return {
    name: "console-errors-baseline",
    status: issues.length > 0 ? "fail" : "pass",
    severity: "critical",
    durationMs: Date.now() - start,
    summary: `${totalNew} novo(s) erro(s) de console em cand não presentes em prod`,
    issues,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
