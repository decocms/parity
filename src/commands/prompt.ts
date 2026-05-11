import { existsSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import { buildLlmPrompt } from "../report/prompt-builder.ts";
import { loadRun } from "../storage/fs.ts";
import type { Issue, Run } from "../types/schema.ts";

export interface PromptOptions {
  output: string;
  out?: string;
  minSeverity?: string;
  limit?: number;
}

export function promptCommand(runId: string, opts: PromptOptions): number {
  let run: Run;
  try {
    run = loadRun(opts.output, runId);
  } catch (err) {
    console.error(chalk.red(`✖ ${(err as Error).message}`));
    return 1;
  }

  const md = buildLlmPrompt(run, {
    minSeverity: opts.minSeverity as Issue["severity"] | undefined,
    limit: opts.limit,
  });

  if (opts.out) {
    writeFileSync(opts.out, md, "utf8");
    console.log(chalk.green(`✔ prompt salvo em ${opts.out}`));
    if (existsSync(opts.out)) {
      const sizeKb = (md.length / 1024).toFixed(1);
      console.log(chalk.dim(`  ${md.length} chars (${sizeKb} KB)`));
    }
  } else {
    process.stdout.write(md);
  }
  return 0;
}
