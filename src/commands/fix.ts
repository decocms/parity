import { type SectionOptions, sectionCommand } from "./section.ts";

export interface FixOptions {
  prod: string;
  cand: string;
  selector: string;
  viewport: string;
  wait: string;
  outDir: string;
  json?: boolean;
  /** Skip the LLM call (offline mode). */
  noLlm?: boolean;
}

/**
 * `parity fix` — "do everything" shortcut for the pixel-perfect debug
 * loop. Internally calls `sectionCommand` with ALL the diagnostic flags
 * turned on (html + screenshot + computed-styles + heatmap + css-source
 * + prompt + llm-summary). Outputs a Markdown prompt + JSON bundle that
 * can be pasted into any LLM, and (when an API key is present) prints a
 * one-paragraph summary of what Claude understood from the signals.
 *
 * Designed for the loop:
 *   1. parity run                → see the diff at a glance
 *   2. parity fix --selector ... → drill into one section
 *   3. paste the markdown into Claude/Cursor → ask for a patch
 *
 * Honors the `--no-llm` escape hatch so the command stays offline-safe
 * (useful in CI or when the API is rate-limited).
 */
export async function fixCommand(opts: FixOptions): Promise<number> {
  const sectionOpts: SectionOptions = {
    prod: opts.prod,
    cand: opts.cand,
    selector: opts.selector,
    viewport: opts.viewport,
    wait: opts.wait,
    outDir: opts.outDir,
    json: opts.json,
    outputHtml: true,
    screenshot: true,
    computedStyles: true,
    heatmap: true,
    cssSource: true,
    prompt: true,
    llmSummary: !opts.noLlm,
  };
  return sectionCommand(sectionOpts);
}
