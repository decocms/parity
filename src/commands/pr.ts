/**
 * `parity pr` — the CI/CD entry point. Runs a comparison between a PR
 * preview URL and prod, then emits a Markdown comment summarizing the
 * deltas (layout, perf, SEO, console) ready to paste into a PR. With
 * `--github`, also writes the same Markdown to `$GITHUB_STEP_SUMMARY`
 * so it shows up under the workflow summary. Issue #79.
 *
 * Internally this is a thin wrapper around `parity run`: we map
 * `--preview → --cand`, hand off to `runCommand`, then read the
 * resulting `report.json` to generate the comment.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { groupIssues } from "../report/group-issues.ts";
import { listRuns } from "../storage/fs.ts";
import type { Issue, Run } from "../types/schema.ts";
import { type RunOptions, runCommand } from "./run.ts";

export interface PrCommandOptions {
  prod: string;
  preview: string;
  /** When set, also write Markdown to $GITHUB_STEP_SUMMARY. */
  github?: boolean;
  /** Write the Markdown comment to this file path instead of stdout. */
  out?: string;
  /** Preset bundle (defaults to "ci" — fast + reliable for PRs). */
  preset?: "smoke" | "ci" | "full";
  output: string;
  /** Output directory passed through to `parity run`. Defaults to "./parity-output". */
}

const SEVERITY_EMOJI: Record<Issue["severity"], string> = {
  critical: "🔴",
  high: "🟠",
  medium: "🟡",
  low: "⚪",
};

export async function prCommand(opts: PrCommandOptions): Promise<number> {
  // Translate to the equivalent `parity run` shape. CI preset by default
  // because PRs need fast + deterministic, not the heavy full audit.
  const runOpts: RunOptions = {
    prod: opts.prod,
    cand: opts.preview,
    flows: "purchase-journey",
    viewports: "mobile",
    cep: "01310-100",
    runs: "1",
    output: opts.output,
    ci: true,
    failOn: "critical,high",
    preset: opts.preset ?? "ci",
    open: false,
  };

  console.log(chalk.dim(`  prod    : ${opts.prod}`));
  console.log(chalk.dim(`  preview : ${opts.preview}`));
  console.log("");

  const runCode = await runCommand(runOpts);

  // Find the run we just produced — listRuns is ordered newest-first.
  const runs = listRuns(opts.output);
  if (runs.length === 0) {
    console.error(chalk.red("no run was produced — cannot build PR comment"));
    return runCode || 1;
  }
  const latest = runs[0]!;
  const reportJsonPath = join(opts.output, "runs", latest.id, "report.json");
  if (!existsSync(reportJsonPath)) {
    console.error(chalk.red(`report.json not found at ${reportJsonPath}`));
    return runCode || 1;
  }
  const run = JSON.parse(readFileSync(reportJsonPath, "utf8")) as Run;

  const markdown = buildPrComment(run, opts);

  if (opts.out) {
    writeFileSync(opts.out, markdown, "utf8");
    console.log(chalk.dim(`  wrote PR comment: ${opts.out}`));
  } else {
    process.stdout.write(`\n${markdown}\n`);
  }

  // GitHub Actions: also write to the step summary so it appears in the
  // run UI without needing a separate "comment" step.
  if (opts.github && process.env.GITHUB_STEP_SUMMARY) {
    try {
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, { flag: "a" });
    } catch (err) {
      console.error(chalk.yellow(`failed to write GITHUB_STEP_SUMMARY: ${(err as Error).message}`));
    }
  }

  return runCode;
}

/**
 * Build a Markdown comment from the Run. Focuses on what a PR reviewer
 * actually needs: top issues by severity, the verdict, and a link back
 * to the full report. Skips noise (per-page tables, raw JSON dumps).
 */
function buildPrComment(run: Run, opts: PrCommandOptions): string {
  const lines: string[] = [];
  const v = run.verdict;
  const status =
    v.status === "pass" ? "✅ **PASS**" : v.status === "warn" ? "⚠ **WARN**" : "❌ **FAIL**";
  const prev = run.previousRun;
  const delta = prev
    ? prev.scoreDelta > 0
      ? ` (📈 +${prev.scoreDelta} vs previous run)`
      : prev.scoreDelta < 0
        ? ` (📉 ${prev.scoreDelta} vs previous run)`
        : " (= previous run)"
    : "";
  lines.push(`## Parity report — ${status} · score ${v.score}/100${delta}`);
  lines.push("");
  lines.push(`- **prod:** ${opts.prod}`);
  lines.push(`- **preview:** ${opts.preview}`);
  lines.push(`- **run id:** \`${run.id}\``);
  if (prev) {
    lines.push(`- **score trend:** ${prev.score} → ${v.score} (previous run \`${prev.id}\`)`);
  }
  lines.push("");
  lines.push("### Verdict");
  lines.push("");
  lines.push("| Critical | High | Medium | Low | Checks pass | Checks fail |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  lines.push(
    `| ${v.critical} | ${v.high} | ${v.medium} | ${v.low} | ${v.checksPassed} | ${v.checksFailed} |`,
  );
  lines.push("");

  // Per-module score breakdown (M3 module scoring) — additive, only shown
  // when the run had module-scoped data (i.e. essentially always, unless
  // no check mapped to a registered module).
  if (run.moduleVerdicts && run.moduleVerdicts.length > 0) {
    lines.push("### Modules");
    lines.push("");
    lines.push("| Module | Score | Status |");
    lines.push("| --- | --- | --- |");
    for (const mv of run.moduleVerdicts) {
      const statusEmoji = mv.status === "pass" ? "✅" : mv.status === "warn" ? "⚠" : "❌";
      lines.push(`| ${mv.module} | ${mv.score}/100 | ${statusEmoji} ${mv.status} |`);
    }
    lines.push("");
  }

  // Top issues — grouped by root cause (same check + normalized summary),
  // sorted by severity then affected-page count.
  const topGroups = groupIssues(run.topIssues.length > 0 ? run.topIssues : run.issues).slice(0, 10);

  if (topGroups.length === 0) {
    lines.push("### Issues");
    lines.push("");
    lines.push("_No issues detected — preview is at parity with prod._");
  } else {
    lines.push(`### Top ${topGroups.length} issue${topGroups.length === 1 ? "" : "s"}`);
    lines.push("");
    for (const g of topGroups) {
      const i = g.sample;
      const where =
        g.pages.length > 1 ? ` · ${g.pages.length} pages` : i.page ? ` · page: \`${i.page}\`` : "";
      lines.push(
        `- ${SEVERITY_EMOJI[i.severity]} \`${i.category}\` · **${i.summary}** _(check: \`${i.check}\`${where})_`,
      );
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(
    `_Generated by [parity](https://github.com/decocms/parity). Run \`parity report ${run.id}\` locally to open the full HTML report._`,
  );
  return lines.join("\n");
}
