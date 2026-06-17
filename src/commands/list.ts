import chalk from "chalk";
import { listRuns, loadRun } from "../storage/fs.ts";

export function listCommand(output: string): number {
  const runs = listRuns(output);
  if (runs.length === 0) {
    console.log(chalk.dim(`Nenhum run salvo em ${output}`));
    return 0;
  }
  for (const r of runs) {
    try {
      const run = loadRun(output, r.id);
      const v = run.verdict;
      const status =
        v.status === "pass"
          ? chalk.green(v.status)
          : v.status === "warn"
            ? chalk.yellow(v.status)
            : chalk.red(v.status);
      console.log(
        `  ${chalk.bold(r.id)}  ${status}  score=${v.score}  critical=${v.critical} high=${v.high}  ${chalk.dim(r.timestamp)}`,
      );
    } catch {
      console.log(`  ${chalk.bold(r.id)}  ${chalk.dim("(report.json ausente)")}`);
    }
  }
  return 0;
}
