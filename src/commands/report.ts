import { existsSync, readFileSync } from "node:fs";
import chalk from "chalk";
import open from "open";
import { getRunPaths, loadRun } from "../storage/fs.ts";
import { extractReportSection, type ReportSection } from "../report/extract-section.ts";

export interface ReportCommandOptions {
  /** Output directory containing runs/. */
  output: string;
  /** Extract a specific section instead of opening the report. Issue #74. */
  section?: ReportSection;
  /** Pair with --section to emit JSON instead of HTML. */
  json?: boolean;
}

/**
 * Open or extract from a saved run's report. Default action: open
 * `report.html` in the system browser. With `--section <name>`, prints the
 * HTML of that one tab to stdout. Add `--json` to print a JSON projection
 * of the same section pulled from `report.json` instead. Issue #74.
 */
export async function reportCommand(
  runId: string,
  opts: ReportCommandOptions,
): Promise<number> {
  const paths = getRunPaths(opts.output, runId);

  if (opts.section) {
    if (opts.json) {
      try {
        const run = loadRun(opts.output, runId);
        const payload = extractReportSection({ kind: "json", section: opts.section, run });
        if (payload === null) {
          console.error(chalk.red(`section "${opts.section}" not present in this run`));
          return 1;
        }
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return 0;
      } catch (err) {
        console.error(chalk.red(`failed to load run: ${(err as Error).message}`));
        return 1;
      }
    }
    if (!existsSync(paths.reportHtml)) {
      console.error(chalk.red(`report.html not found at ${paths.reportHtml}`));
      return 1;
    }
    const html = readFileSync(paths.reportHtml, "utf8");
    const slice = extractReportSection({ kind: "html", section: opts.section, html }) as string | null;
    if (slice === null) {
      console.error(chalk.red(`section "${opts.section}" not present in this report`));
      return 1;
    }
    process.stdout.write(slice);
    return 0;
  }

  console.log(chalk.dim(`opening ${paths.reportHtml}`));
  await open(paths.reportHtml).catch((err) => {
    console.error(chalk.red(`failed to open: ${(err as Error).message}`));
  });
  return 0;
}
