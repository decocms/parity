import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import open from "open";
import { renderDeckHtml } from "../report/deck-html.ts";
import { buildDeckModel } from "../report/deck-model.ts";
import {
  ALL_REPORT_SECTIONS,
  type ReportSection,
  extractReportSection,
} from "../report/extract-section.ts";
import { getRunPaths, loadRun } from "../storage/fs.ts";

export interface ReportCommandOptions {
  /** Output directory containing runs/. */
  output: string;
  /** Extract a specific section instead of opening the report. Issue #74. */
  section?: ReportSection;
  /** Pair with --section to emit JSON instead of HTML. */
  json?: boolean;
  /** Render the presentation deck instead of opening the dashboard. Issue #290. */
  deck?: boolean;
  /** Where to write the deck. Defaults to `deck.html` inside the run dir. */
  out?: string;
  /** Initial deck language; the in-page toggle still switches live. */
  lang?: "pt" | "en";
  /** Open the rendered deck in the browser. */
  open?: boolean;
}

/**
 * Open or extract from a saved run's report. Default action: open
 * `report.html` in the system browser. With `--section <name>`, prints the
 * HTML of that one tab to stdout. Add `--json` to print a JSON projection
 * of the same section pulled from `report.json` instead. Issue #74.
 */
export async function reportCommand(runId: string, opts: ReportCommandOptions): Promise<number> {
  const paths = getRunPaths(opts.output, runId);

  if (opts.deck) {
    let run: ReturnType<typeof loadRun>;
    try {
      run = loadRun(opts.output, runId);
    } catch (err) {
      console.error(chalk.red(`failed to load run: ${(err as Error).message}`));
      return 1;
    }
    const html = renderDeckHtml(buildDeckModel(run), opts.lang ?? "en");
    const dest = opts.out ?? join(paths.runDir, "deck.html");
    writeFileSync(dest, html, "utf8");
    console.log(`${chalk.green("✓")} deck → ${dest}`);
    if (opts.open) {
      await open(dest).catch((err) => {
        console.error(chalk.red(`failed to open: ${(err as Error).message}`));
      });
    }
    return 0;
  }

  if (opts.section) {
    // Validate the NAME before asking the extractor. Without this an unknown name fell through to
    // `section "x" not present in this report`, which reads as "missing from this run" rather than
    // "no such section" — a typo looked like a broken report. `ALL_REPORT_SECTIONS` existed for
    // exactly this and was never used.
    if (!ALL_REPORT_SECTIONS.includes(opts.section)) {
      console.error(chalk.red(`unknown section "${opts.section}"`));
      console.error(chalk.gray(`  valid: ${ALL_REPORT_SECTIONS.join(", ")}`));
      return 1;
    }
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
    const slice = extractReportSection({ kind: "html", section: opts.section, html }) as
      | string
      | null;
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
