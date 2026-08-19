import chalk from "chalk";
import { launchBrowser, newContext } from "../engine/browser.ts";
import { attachCollectors, flushCollectors } from "../engine/collect.ts";
import type { ConsoleEntry, Viewport } from "../types/schema.ts";

export interface ConsoleOptions {
  url: string;
  viewport: string;
  /** Extra milliseconds to wait after networkidle so client-side errors land. */
  wait: string;
  /** Filter: comma-separated subset of error|warning|log|info|debug (default: error,warning). */
  filter?: string;
  /** Emit one-line JSON instead of human-readable table. */
  json?: boolean;
}

/**
 * `parity console` — single-page console capture (issue #31, PR 1).
 *
 * Boots a context, attaches the same listeners `capturePage` uses, navigates,
 * waits for networkidle + an explicit settle window, then prints what came
 * out. No screenshots, no checks, no LLM, no report files. Designed for a
 * sub-10s debug loop: "did my fix kill that 401?".
 *
 * Reuses `attachCollectors` so the output schema (ConsoleEntry) matches what
 * the full `parity run` produces — scripts that parse one can parse the other.
 */
export async function consoleCommand(opts: ConsoleOptions): Promise<number> {
  const viewport = parseViewport(opts.viewport);
  if (!viewport) {
    console.error(chalk.red(`viewport inválido: ${opts.viewport} (use mobile|desktop|tablet)`));
    return 2;
  }
  const waitMs = Number.parseInt(opts.wait, 10);
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    console.error(chalk.red(`--wait inválido: ${opts.wait}`));
    return 2;
  }
  const filter = parseFilter(opts.filter);

  let url: URL;
  try {
    url = new URL(opts.url);
  } catch {
    console.error(chalk.red(`--url inválido: ${opts.url}`));
    return 2;
  }

  const browser = await launchBrowser({ headless: true });
  try {
    const ctx = await newContext(browser, { viewport });
    const page = await ctx.newPage();
    // MUST be installed BEFORE goto — otherwise we miss early errors that
    // fire during the navigation itself (auth 401s, request-failed on
    // first-party scripts, etc).
    const state = attachCollectors(page);
    try {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (err) {
      // Goto failures are also useful signal — record them but keep going so
      // any console errors that DID fire before the failure still surface.
      state.console.push({
        type: "error",
        text: `[navigation-error] ${(err as Error).message}`,
      });
    }
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    await flushCollectors(state, 3_000);

    const filtered = state.console.filter((e) => filter.has(e.type));
    printResults(filtered, { url: url.toString(), viewport, json: opts.json === true });
    return filtered.some((e) => e.type === "error") ? 1 : 0;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function parseViewport(raw: string): Viewport | null {
  if (raw === "mobile" || raw === "desktop" || raw === "tablet") return raw;
  return null;
}

export function parseFilter(raw: string | undefined): Set<ConsoleEntry["type"]> {
  const valid = new Set<ConsoleEntry["type"]>(["error", "warning", "log", "info", "debug"]);
  if (!raw) return new Set<ConsoleEntry["type"]>(["error", "warning"]);
  const wanted = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ConsoleEntry["type"] => valid.has(s as ConsoleEntry["type"]));
  return new Set(wanted.length > 0 ? wanted : (["error", "warning"] as ConsoleEntry["type"][]));
}

function printResults(
  entries: ConsoleEntry[],
  meta: { url: string; viewport: Viewport; json: boolean },
): void {
  if (meta.json) {
    console.log(JSON.stringify({ url: meta.url, viewport: meta.viewport, entries }));
    return;
  }
  if (entries.length === 0) {
    console.log(
      chalk.dim(
        `  ${meta.viewport} · ${meta.url}\n  nenhuma entrada de console nos filtros pedidos`,
      ),
    );
    return;
  }
  console.log(chalk.bold(`\n  ${meta.viewport} · ${meta.url}`));
  console.log(chalk.dim(`  ${entries.length} entrada(s)\n`));
  for (const e of entries) {
    const tag =
      e.type === "error"
        ? chalk.red("[error  ]")
        : e.type === "warning"
          ? chalk.yellow("[warn   ]")
          : chalk.dim(`[${e.type.padEnd(7)}]`);
    const loc = e.location ? chalk.dim(`  ← ${e.location}`) : "";
    // Trim very long lines so the output stays readable in a terminal.
    const text = e.text.length > 400 ? `${e.text.slice(0, 397)}...` : e.text;
    console.log(`  ${tag} ${text}${loc}`);
  }
}
