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
import { runCommand, type RunOptions } from "./run.ts";
import type { Issue, Run } from "../types/schema.ts";
import { listRuns } from "../storage/fs.ts";

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

const SEVERITY_RANK: Record<Issue["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
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
  const status = v.status === "pass" ? "✅ **PASS**" : v.status === "warn" ? "⚠ **WARN**" : "❌ **FAIL**";
  lines.push(`## Parity report — ${status} · score ${v.score}/100`);
  lines.push("");
  lines.push(`- **prod:** ${opts.prod}`);
  lines.push(`- **preview:** ${opts.preview}`);
  lines.push(`- **run id:** \`${run.id}\``);
  lines.push("");
  lines.push("### Verdict");
  lines.push("");
  lines.push(
    `| Critical | High | Medium | Low | Checks pass | Checks fail |`,
  );
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  lines.push(
    `| ${v.critical} | ${v.high} | ${v.medium} | ${v.low} | ${v.checksPassed} | ${v.checksFailed} |`,
  );
  lines.push("");

  // Top issues — sorted by severity then alphabetically.
  const topIssues = (run.topIssues.length > 0 ? run.topIssues : run.issues)
    .slice()
    .sort((a, b) => {
      const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      return r !== 0 ? r : a.summary.localeCompare(b.summary);
    })
    .slice(0, 10);

  if (topIssues.length === 0) {
    lines.push("### Issues");
    lines.push("");
    lines.push("_No issues detected — preview is at parity with prod._");
  } else {
    lines.push(`### Top ${topIssues.length} issue${topIssues.length === 1 ? "" : "s"}`);
    lines.push("");
    for (const i of topIssues) {
      lines.push(`- ${SEVERITY_EMOJI[i.severity]} \`${i.category}\` · **${i.summary}** _(check: \`${i.check}\`${i.page ? ` · page: \`${i.page}\`` : ""})_`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(
    "_Generated by [parity](https://github.com/decocms/parity). Run \`parity report " +
      run.id +
      "\` locally to open the full HTML report._",
  );
  return lines.join("\n");
}
