import chalk from "chalk";
import open from "open";
import { getRunPaths } from "../storage/fs.ts";

export async function reportCommand(runId: string, output: string): Promise<number> {
  const paths = getRunPaths(output, runId);
  console.log(chalk.dim(`opening ${paths.reportHtml}`));
  await open(paths.reportHtml).catch((err) => {
    console.error(chalk.red(`failed to open: ${(err as Error).message}`));
  });
  return 0;
}
