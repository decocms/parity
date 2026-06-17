/**
 * Interactive selector prompt for solo-dev mode (Issue #72).
 *
 * When `parity run` can't find an element via the default selectors and
 * neither LLM recovery nor a `.parityrc.json` override is configured, we
 * either:
 *   a) prompt the dev to type the right selector (if running in a TTY
 *      without an LLM provider — the "solo dev" mode), or
 *   b) emit a structured error for an agent to handle.
 *
 * The prompt writes the new selector into `.parityrc.json` at the project
 * root so the run can be re-executed deterministically, then optionally
 * opens the file in the user's default editor on macOS via `open`.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { isLlmAvailable } from "../llm/client.ts";

let forceDisabled = false;

/** Hard-disable interactive mode regardless of TTY/LLM detection. */
export function disableInteractive(): void {
  forceDisabled = true;
}

/**
 * Auto-detect whether we should enter interactive mode. True when ALL of:
 *   - `--no-interactive` was NOT passed (forceDisabled is false)
 *   - stdout AND stdin are TTYs (so we can both prompt and read input)
 *   - no LLM provider is configured (any provider would handle this for us)
 */
export function isInteractiveMode(): boolean {
  if (forceDisabled) return false;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  if (isLlmAvailable()) return false;
  return true;
}

export interface SelectorPromptInput {
  /** The .parityrc.json key the selector will be written to (e.g. "categoryLink"). */
  selectorKey: string;
  /** What the runner was trying to do (e.g. "click a PLP category link"). */
  intendedAction: string;
  /** Selectors that were attempted and failed, for the dev's reference. */
  alreadyTried: string[];
  /** Live URL when the failure happened. */
  pageUrl: string;
  /**
   * Compact HTML snapshot of the page at the failure moment. Limited to
   * `maxHtmlChars` (default 4000) so the dev can scan it inline without
   * a separate viewer. The full HTML is dumped to a temp file when too
   * long.
   */
  htmlSnapshot: string;
  /**
   * Working directory; the `.parityrc.json` lookup starts here. Defaults
   * to `process.cwd()`.
   */
  cwd?: string;
}

/**
 * Structured error shape returned to non-interactive callers (CI, agents).
 * Agents can parse this from a JSON log line and write `.parityrc.json`
 * themselves.
 */
export interface SelectorPromptStructuredError {
  kind: "missing-selector";
  selectorKey: string;
  intendedAction: string;
  alreadyTried: string[];
  pageUrl: string;
  /** First 2000 chars of the compacted HTML; full snapshot too large to ship. */
  htmlSnapshot: string;
  suggestedRcPath: string;
}

const PARITYRC_FILENAME = ".parityrc.json";

/**
 * Prompt the dev for a selector. Returns the typed selector string on
 * success, or null when the dev aborts (Ctrl+C, empty input). Writes the
 * selector into `.parityrc.json` under `selectors.<selectorKey>` and
 * tries to open the file in the user's default editor afterward.
 */
export async function promptForSelector(input: SelectorPromptInput): Promise<string | null> {
  const cwd = input.cwd ?? process.cwd();
  printContextHeader(input);
  const selector = await readLine("Selector for this step (or blank to skip): ");
  if (!selector?.trim()) {
    console.log("  (no selector entered — continuing without override)");
    return null;
  }
  const trimmed = selector.trim();
  const rcPath = resolve(cwd, PARITYRC_FILENAME);
  writeSelectorOverride(rcPath, input.selectorKey, trimmed);
  console.log(`  ✓ wrote selectors.${input.selectorKey} = ${trimmed}  →  ${rcPath}`);
  tryOpenInEditor(rcPath);
  return trimmed;
}

/**
 * Build the structured error object for non-interactive callers (CI/agents)
 * to consume. Caps the HTML snapshot so the error stays printable. The
 * caller is responsible for emitting this somewhere visible (stderr, the
 * JSONL stream, etc.) and exiting.
 */
export function buildStructuredError(input: SelectorPromptInput): SelectorPromptStructuredError {
  return {
    kind: "missing-selector",
    selectorKey: input.selectorKey,
    intendedAction: input.intendedAction,
    alreadyTried: input.alreadyTried,
    pageUrl: input.pageUrl,
    htmlSnapshot: input.htmlSnapshot.slice(0, 2000),
    suggestedRcPath: resolve(input.cwd ?? process.cwd(), PARITYRC_FILENAME),
  };
}

function printContextHeader(input: SelectorPromptInput): void {
  const bar = "─".repeat(60);
  console.log("");
  console.log(bar);
  console.log(`⚠  Selector missing: ${input.selectorKey}`);
  console.log(bar);
  console.log(`  step:      ${input.intendedAction}`);
  console.log(`  page:      ${input.pageUrl}`);
  if (input.alreadyTried.length > 0) {
    console.log(`  tried:     ${input.alreadyTried.slice(0, 5).join(", ")}`);
  }
  console.log("");
  console.log("  HTML snapshot (top of page):");
  const lines = input.htmlSnapshot.split("\n").slice(0, 25);
  for (const ln of lines) console.log(`  | ${ln}`);
  if (input.htmlSnapshot.split("\n").length > 25) console.log("  | … (truncated)");
  console.log("");
}

function readLine(prompt: string): Promise<string | null> {
  return new Promise((resolveLine) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolveLine(answer);
    });
    rl.on("SIGINT", () => {
      rl.close();
      resolveLine(null);
    });
  });
}

interface PartialRc {
  selectors?: Record<string, string>;
  [key: string]: unknown;
}

function writeSelectorOverride(rcPath: string, key: string, value: string): void {
  let current: PartialRc = {};
  if (existsSync(rcPath)) {
    try {
      const parsed = JSON.parse(readFileSync(rcPath, "utf8")) as PartialRc;
      if (parsed && typeof parsed === "object") current = parsed;
    } catch {
      // malformed JSON — keep it but warn so the dev knows we overwrote
      console.log(`  ⚠ existing ${PARITYRC_FILENAME} was not valid JSON; overwriting.`);
    }
  }
  current.selectors = { ...(current.selectors ?? {}), [key]: value };
  writeFileSync(rcPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

function tryOpenInEditor(rcPath: string): void {
  if (process.platform !== "darwin") return; // `open` is macOS-only
  try {
    execSync(`open ${JSON.stringify(rcPath)}`, { stdio: "ignore" });
  } catch {
    /* tolerated — opening the file is a nicety, not required */
  }
}
