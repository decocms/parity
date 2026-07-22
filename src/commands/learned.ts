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
    const staleNote = p.staleSelectors > 0 ? ` · ${chalk.yellow(`${p.staleSelectors} stale`)}` : "";
    console.log(
      `${chalk.cyan(p.platform)}: ${p.activeSelectors} active (${p.verifiedSelectors} verified, ${p.llmGuessSelectors} llm-guess) · ${chalk.dim(`${p.deprecatedSelectors} deprecated`)}${staleNote}`,
    );
    for (const top of p.topByKey) {
      const sr = `${(top.successRate * 100).toFixed(0)}%`;
      const originTag = top.origin === "llm-guess" ? chalk.yellow(" [guess]") : "";
      console.log(
        `   ${chalk.dim(top.key.padEnd(18))} ${chalk.green(sr.padStart(4))}  ${chalk.dim(`(${top.hosts} hosts)`)}  ${top.selector}${originTag}`,
      );
    }
    console.log("");
  }
  return 0;
}
