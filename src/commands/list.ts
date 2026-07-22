import chalk from "chalk";
import { MODULES } from "../checks/modules.ts";
import { listRuns, loadRun } from "../storage/fs.ts";

/**
 * `parity list modules` — prints the 8 selectable modules (M3 module
 * selection) with their descriptions and check/flow membership, so
 * `--only`/`--skip` values are discoverable without reading source.
 */
export function listModulesCommand(json: boolean): number {
  if (json) {
    console.log(JSON.stringify(MODULES, null, 2));
    return 0;
  }
  for (const mod of Object.values(MODULES)) {
    console.log(`  ${chalk.bold(mod.name)}  ${chalk.dim(mod.description)}`);
    console.log(`    checks: ${mod.checks.join(", ")}`);
    console.log(`    flows:  ${mod.flows.join(", ")}`);
    if (mod.needsSitemapPages) console.log(chalk.dim("    needs sitemap-page crawling"));
    if (mod.needsLlm) console.log(chalk.dim("    needs an LLM pass for full value"));
    console.log("");
  }
  return 0;
}

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
