import chalk from "chalk";
import { LEARNED_PATH, loadLearned, statsFromLib } from "../learned/repo.ts";

export function learnedStats(): number {
  const lib = loadLearned();
  const stats = statsFromLib(lib);
  if (stats.platforms.length === 0) {
    console.log(chalk.dim(`Biblioteca vazia: ${LEARNED_PATH}`));
    console.log(chalk.dim("Rode `parity run ...` em algum site para começar a popular."));
    return 0;
  }
  console.log(chalk.bold(`\nlearned-selectors stats (${LEARNED_PATH})\n`));
  for (const p of stats.platforms) {
    console.log(
      `${chalk.cyan(p.platform)}: ${p.activeSelectors} active · ${chalk.dim(`${p.deprecatedSelectors} deprecated`)}`,
    );
    for (const top of p.topByKey) {
      const sr = `${(top.successRate * 100).toFixed(0)}%`;
      console.log(
        `   ${chalk.dim(top.key.padEnd(18))} ${chalk.green(sr.padStart(4))}  ${chalk.dim(`(${top.hosts} hosts)`)}  ${top.selector}`,
      );
    }
    console.log("");
  }
  return 0;
}
