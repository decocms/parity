import chalk from "chalk";
import { deleteBaseline, listBaselines, saveBaseline } from "../storage/baselines.ts";
import { loadRun } from "../storage/fs.ts";

export interface BaselineSetOptions {
  output: string;
  name: string;
}

export async function baselineSet(runId: string, opts: BaselineSetOptions): Promise<number> {
  try {
    const run = loadRun(opts.output, runId);
    const path = saveBaseline(opts.name, run);
    console.log(chalk.green(`✔ Baseline "${opts.name}" criada a partir de ${runId}`));
    console.log(chalk.dim(`  → ${path}`));
    return 0;
  } catch (err) {
    console.error(chalk.red(`✖ ${(err as Error).message}`));
    return 1;
  }
}

export function baselineList(): number {
  const items = listBaselines();
  if (items.length === 0) {
    console.log(chalk.dim("Nenhuma baseline salva."));
    return 0;
  }
  for (const b of items) {
    console.log(`  ${chalk.bold(b.name)}  ${chalk.dim(b.createdAt)}  ${chalk.dim(b.path)}`);
  }
  return 0;
}

export function baselineUnset(name: string): number {
  try {
    deleteBaseline(name);
    console.log(chalk.green(`✔ Baseline "${name}" removida`));
    return 0;
  } catch (err) {
    console.error(chalk.red(`✖ ${(err as Error).message}`));
    return 1;
  }
}
