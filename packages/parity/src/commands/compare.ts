import chalk from "chalk";
import { compareToBaseline, loadBaseline } from "../storage/baselines.ts";
import { loadRun } from "../storage/fs.ts";

export function compareCommand(runId: string, baselineName: string, output: string): number {
  try {
    const run = loadRun(output, runId);
    const baseline = loadBaseline(baselineName);
    const delta = compareToBaseline(run, baseline);
    console.log(chalk.bold(`\nDelta ${runId} vs baseline "${baselineName}"`));
    console.log(`  ${chalk.green("✓ resolved")}: ${delta.resolved.length}`);
    console.log(`  ${chalk.yellow("+ new")}:      ${delta.new.length}`);
    console.log(`  ${chalk.red("⚠ regressed")}: ${delta.regressions.length}`);
    if (delta.new.length > 0) {
      console.log(chalk.bold("\nNovos issue ids:"));
      for (const id of delta.new) console.log(`  - ${id}`);
    }
    if (delta.regressions.length > 0) {
      console.log(chalk.bold("\nRegressões (severity piorou):"));
      for (const id of delta.regressions) console.log(`  - ${id}`);
    }
    return 0;
  } catch (err) {
    console.error(chalk.red(`✖ ${(err as Error).message}`));
    return 1;
  }
}
