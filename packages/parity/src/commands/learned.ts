import chalk from "chalk";
import type { Browser } from "playwright";
import { launchBrowser, newContext, userAgentFor } from "../engine/browser.ts";
import { validateSelectors } from "../engine/validate-selectors.ts";
import { LEARNED_PATH, loadLearned, statsFromLib } from "../learned/repo.ts";
import { isLlmAvailable } from "../llm/client.ts";
import { type DiscoveredSelectors, discoverSelectorsFromUrl } from "../llm/discover-selectors.ts";

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

/**
 * Standalone diagnostic: `parity learned validate --url <url>`.
 *
 * Fetches the URL's home HTML, runs LLM selector discovery (single-page —
 * this is a debug tool, not the full run.ts pre-browser PLP/PDP pre-fetch;
 * see M4 roadmap notes), launches a throwaway browser, live-validates every
 * discovered selector against the home page, and prints a
 * key → selector → validated?/not-validated/not-checked table. Not part of
 * the main `parity run` flow — purely for a human to sanity-check what
 * discovery + validation would produce for a given site before committing
 * to a full run.
 */
export async function learnedValidate(url: string): Promise<number> {
  if (!isLlmAvailable()) {
    console.error(
      chalk.red(
        "  ✖ nenhuma chave de LLM configurada (ANTHROPIC_API_KEY / OPENROUTER_API_KEY) — discovery precisa do LLM",
      ),
    );
    return 2;
  }

  console.log(chalk.dim(`  Baixando home de ${url}…`));
  let html: string | null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgentFor("desktop"), Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    html = res.ok ? await res.text() : null;
  } catch (err) {
    console.error(chalk.red(`  ✖ falha ao baixar ${url}: ${(err as Error).message}`));
    return 2;
  }
  if (!html) {
    console.error(chalk.red(`  ✖ falha ao baixar ${url} (HTTP não-2xx ou erro de rede)`));
    return 2;
  }

  console.log(chalk.dim("  Descobrindo seletores via LLM…"));
  const discovered = await discoverSelectorsFromUrl(url, html, { noCache: true });
  if (!discovered) {
    console.error(chalk.red("  ✖ LLM não retornou seletores"));
    return 2;
  }

  console.log(chalk.dim("  Validando ao vivo (browser headless)…"));
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser({ headless: true });
    const ctx = await newContext(browser, { viewport: "desktop" });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
    const { validated } = await validateSelectors(page, discovered);
    await ctx.close();

    const lowConfidence = new Set(discovered.lowConfidenceKeys ?? []);
    console.log(chalk.bold(`\nlearned validate — ${url}\n`));
    for (const key of Object.keys(discovered) as (keyof DiscoveredSelectors)[]) {
      if (key === "lowConfidenceKeys") continue;
      const selector = discovered[key];
      if (!selector) {
        console.log(`  ${chalk.dim(key.padEnd(20))} ${chalk.dim("(vazio — LLM não detectou)")}`);
        continue;
      }
      const state =
        validated[key] === true
          ? chalk.green("validated")
          : validated[key] === false
            ? chalk.red("not-validated")
            : chalk.yellow("not-checked");
      const guessTag = lowConfidence.has(key) ? chalk.yellow(" [low-confidence]") : "";
      console.log(`  ${key.padEnd(20)} ${state.padEnd(22)} ${selector}${guessTag}`);
    }
    console.log("");
    return 0;
  } catch (err) {
    console.error(chalk.red(`  ✖ validação ao vivo falhou: ${(err as Error).message}`));
    return 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
