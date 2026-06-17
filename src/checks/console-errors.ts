import { diffConsole } from "../diff/console.ts";
import type { CheckResult, EvidenceRef, Issue, Severity } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";
import { pairCaptures } from "./lib/pairing.ts";

/**
 * Console-error baseline check. Compares prod's console output to cand's
 * per-page and reports errors that appear *only* in cand.
 *
 * Dedup across pages: previously this emitted one Issue per (page × error)
 * pair, which produced 4-5 identical "Top issues" entries when a single
 * domain-key mismatch leaked across home, /s, /search, etc. Now we group
 * by normalized error key across all page pairs and emit ONE issue per
 * unique error with the affected-pages list inline.
 */
export function consoleErrorsBaseline(ctx: CheckContext): CheckResult {
  const start = Date.now();
  const { pairs } = pairCaptures(ctx.prodPages, ctx.candPages);

  // key → aggregated metadata across all pages where this error appeared
  const byKey = new Map<
    string,
    {
      cls: string;
      sampleText: string;
      pages: string[];
      // First cand screenshot we saw for this error — used as the
      // evidence pointer (good enough; agent reviewers can find others
      // via the page list).
      sampleEvidence: EvidenceRef[];
    }
  >();
  let totalNew = 0;

  for (const pair of pairs) {
    const diff = diffConsole(pair.prod.console, pair.cand.console, {
      ignorePatterns: ctx.ignore.ignoreConsolePatterns,
      errorsOnly: true,
    });
    totalNew += diff.newInCand.length;
    for (const e of diff.newInCand) {
      const existing = byKey.get(e.key);
      if (!existing) {
        byKey.set(e.key, {
          cls: e.cls,
          sampleText: e.entry.text,
          pages: [pair.key],
          sampleEvidence: [
            { kind: "screenshot", path: pair.cand.screenshotPath, label: "cand" },
          ],
        });
      } else if (!existing.pages.includes(pair.key)) {
        existing.pages.push(pair.key);
      }
    }
  }

  const issues: Issue[] = [];
  for (const [key, agg] of byKey) {
    const pageList =
      agg.pages.length <= 5
        ? agg.pages.join(" · ")
        : `${agg.pages.slice(0, 5).join(" · ")} +${agg.pages.length - 5} more`;
    const pageSuffix =
      agg.pages.length === 1 ? `em ${agg.pages[0]}` : `em ${agg.pages.length} páginas (${pageList})`;
    const severity: Severity = agg.cls === "hydration" ? "critical" : "high";
    issues.push({
      id: `console:${hash(key)}`,
      severity,
      category: "console",
      page: agg.pages[0],
      check: "console-errors-baseline",
      summary: `[${agg.cls}] novo erro de console ${pageSuffix}: ${truncate(agg.sampleText, 160)}`,
      details: `${agg.sampleText}\n\nObserved on: ${agg.pages.join(", ")}`,
      evidence: agg.sampleEvidence,
    });
  }

  return {
    name: "console-errors-baseline",
    status: issues.length > 0 ? "fail" : "pass",
    severity: "critical",
    durationMs: Date.now() - start,
    summary:
      issues.length > 0
        ? `${issues.length} erro(s) único(s) novo(s) em cand (${totalNew} ocorrência(s) somando todas as páginas)`
        : `${totalNew} novo(s) erro(s) de console em cand não presentes em prod`,
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
