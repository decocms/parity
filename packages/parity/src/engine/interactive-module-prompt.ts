/**
 * Interactive module-selection prompt (M3 — module selection, phase A).
 *
 * When `parity run` is launched from a TTY with none of `--only`, `--skip`,
 * or `--preset` given, we ask the dev which modules to run instead of
 * silently running all 8 (which is the safe default for non-TTY/CI
 * callers — see `noSelectionNudge` in `src/commands/run.ts`).
 *
 * Mirrors `interactive-selector-prompt.ts`'s mechanics: plain `readline`
 * (no extra TUI dependency), single question/answer round-trip, Ctrl+C or
 * empty input falls back to the safe default (here: keep everything
 * checked).
 */

import { createInterface } from "node:readline";
import { MODULES, type ModuleName } from "../checks/modules.ts";

const ALL_MODULE_NAMES = Object.keys(MODULES) as ModuleName[];

/**
 * Shows all 8 modules pre-checked with their descriptions, and lets the
 * dev type a comma-separated list of numbers to UNCHECK before confirming.
 * Returns the resulting module list (all modules when the dev just hits
 * Enter), or `null` on abort (Ctrl+C) — callers should treat `null` the
 * same as "no selection made" (i.e. run everything).
 */
export async function promptForModuleSelection(): Promise<ModuleName[] | null> {
  console.log("");
  console.log("  Select modules to run (all checked by default):");
  console.log("");
  ALL_MODULE_NAMES.forEach((name, i) => {
    const def = MODULES[name];
    console.log(`    [x] ${i + 1}. ${name.padEnd(8)} — ${def.description}`);
  });
  console.log("");
  const answer = await readLine(
    "  Type numbers to UNCHECK (comma-separated), or press Enter to run all: ",
  );
  if (answer === null) {
    console.log("  (aborted — running all modules)");
    return ALL_MODULE_NAMES;
  }
  const trimmed = answer.trim();
  if (!trimmed) return ALL_MODULE_NAMES;

  const uncheckIdx = new Set(
    trimmed
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= ALL_MODULE_NAMES.length),
  );
  const selected = ALL_MODULE_NAMES.filter((_name, i) => !uncheckIdx.has(i + 1));
  if (selected.length === 0) {
    console.log("  (everything unchecked — running all modules instead)");
    return ALL_MODULE_NAMES;
  }
  console.log(`  running: ${selected.join(", ")}`);
  return selected;
}

function readLine(prompt: string): Promise<string | null> {
  return new Promise((resolveLine) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => {
      rl.close();
      resolveLine(ans);
    });
    rl.on("SIGINT", () => {
      rl.close();
      resolveLine(null);
    });
  });
}
