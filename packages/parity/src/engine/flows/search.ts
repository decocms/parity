import type { Page } from "playwright";
import { resolveSearchTerms } from "../../llm/resolve-search-terms.ts";
import type { PageCapture, StepCapture } from "../../types/schema.ts";
import { capturePage } from "../collect.ts";
import type { FlowContext, FlowResult } from "./shared.ts";
import {
  findElement,
  makeSkipStep,
  screenshotPath,
  screenshotStable,
  selFor,
  withCap,
} from "./shared.ts";
import { countProductCards } from "./simple.ts";

// ---------------------------------------------------------------------------
// Fase 2 flows — search / cart-interactions / login.
// ---------------------------------------------------------------------------

const NO_RESULTS_TEXT_PATTERNS: RegExp[] = [
  /nenhum (resultado|produto|item)/i,
  /n[aã]o encontramos/i,
  /n[aã]o foi(ram)? encontrad/i,
  /n[aã]o encontrad/i, // covers "não encontrada", "não encontrado", and the Miess "BUSCA NÃO ENCONTRADA"
  /busca n[aã]o encontrada/i,
  /sem resultados/i,
  /no results/i,
  /no products/i,
  /\bno items\b/i,
  /0 (resultado|produto|item)/i,
  /didn[’']?t find/i,
  /sorry,? we couldn[’']?t find/i,
  // VTEX Intelligent Search typical strings
  /n[aã]o encontramos resultados/i,
  /resultados? para\s+["“'].*["”']\s*[\(:]?\s*0/i,
];

/**
 * Detect a "no results" / empty-state banner.
 *
 * Three sources of truth checked (most reliable first):
 *  1. Page innerText() — what the user actually sees on the rendered page.
 *  2. The full HTML capture passed in (more reliable when SPA hydration is
 *     slow and innerText misses a heading that's actually in the DOM).
 *  3. Proximity heuristic — if the search term appears near a negative cue
 *     ("não", "no", "0", "sem"), that's an empty-state pattern even if our
 *     hardcoded regexes don't match the exact phrasing.
 */
async function detectNoResultsEmptyState(
  page: Page,
  capturedHtml: string,
  term?: string,
): Promise<boolean> {
  const innerText = await withCap(
    page
      .locator("body")
      .innerText()
      .catch(() => ""),
    2_000,
    "",
  );

  // Pool of text to scan: rendered innerText + raw HTML (catches text
  // inserted between capture and our innerText call, or in attributes).
  const haystack = `${innerText}\n${capturedHtml}`;

  if (NO_RESULTS_TEXT_PATTERNS.some((re) => re.test(haystack))) return true;

  if (term && term.length >= 4) {
    const lowerHaystack = haystack.toLowerCase();
    const idx = lowerHaystack.indexOf(term.toLowerCase());
    if (idx >= 0) {
      const around = haystack.slice(Math.max(0, idx - 120), idx + term.length + 120);
      if (/\b(n[aã]o|nenhum|sem|\b0\b|zero|no)\b/i.test(around)) return true;
    }
  }
  return false;
}

/**
 * Build the URL the site uses for `?q=<term>` searches.
 *
 * Most platforms accept `/search?q=` (VTEX, Shopify) or `/s?q=` (VTEX legacy).
 * If `searchUrlHint` is set in rc.search, use that; otherwise we'll attempt
 * `/search?q=<term>` first and `/s?q=<term>` as fallback — Playwright will
 * follow whichever 404s vs renders.
 */
function searchUrlFor(baseUrl: string, term: string, path = "/search"): string {
  const u = new URL(path, baseUrl);
  u.searchParams.set("q", term);
  return u.toString();
}

export async function flowSearch(ctx: FlowContext): Promise<FlowResult> {
  const pages: PageCapture[] = [];
  const steps: StepCapture[] = [];
  const total = 6;
  const reportStart = (idx: number, name: string) =>
    ctx.onStep?.({ phase: "start", name, index: idx, total });
  const reportEnd = (
    idx: number,
    name: string,
    status: StepCapture["status"],
    durationMs: number,
    note?: string,
  ) => ctx.onStep?.({ phase: "end", name, index: idx, total, status, durationMs, note });

  const typeDelayMs = ctx.rc.search?.typeDelayMs ?? 80;
  const budget = { remaining: ctx.recoveryBudget ?? 3 };
  const page = await ctx.ctx.newPage();

  try {
    // Step 1: visit-home
    reportStart(1, "visit-home");
    const homeCap = await capturePage(page, {
      url: ctx.baseUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "search-1-home"),
    });
    pages.push(homeCap);
    const step1Status: StepCapture["status"] =
      homeCap.status >= 200 && homeCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 1,
      name: "visit-home",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step1Status,
      durationMs: homeCap.durationMs,
      url: homeCap.finalUrl,
      screenshotPath: homeCap.screenshotPath,
      actionDescription: `Navegou pra home \`${ctx.baseUrl}\` (HTTP ${homeCap.status})`,
    });
    reportEnd(1, "visit-home", step1Status, homeCap.durationMs);
    if (step1Status === "failed") return { pages, steps };

    // Resolve search terms (with-results + no-results)
    const terms = await resolveSearchTerms(ctx.baseUrl, homeCap.html, {
      rc: ctx.rc,
      runId: ctx.runId,
    }).catch(() => ({ withResults: "produto", noResults: `zzqxxq-${Date.now().toString(36)}` }));

    // Step 2: open-search — click trigger if input not already visible.
    // `findElement` handles the cascade (override → learned → defaults → LLM recovery).
    reportStart(2, "open-search");
    const t2 = Date.now();
    let inputHit = await findElement(page, ctx, {
      key: "searchInput",
      intent:
        "Encontrar o <input> de BUSCA na página (campo de texto onde o usuário digita o termo a buscar). NÃO retorne input de email, newsletter, ou CEP.",
      budget,
      stepName: "find-search-input",
    });
    let usedTrigger: string | null = null;
    let triggerRecoveredByLlm = false;
    let inputRecoveredByLlm = inputHit?.recoveredByLlm ?? false;

    if (!inputHit) {
      const triggerHit = await findElement(page, ctx, {
        key: "searchTrigger",
        intent:
          "Encontrar o ícone/botão de lupa/busca no header que ABRE o input de busca quando clicado (mobile geralmente esconde o input atrás de um trigger).",
        budget,
        stepName: "open-search-trigger",
      });
      if (triggerHit) {
        usedTrigger = triggerHit.selector;
        triggerRecoveredByLlm = triggerHit.recoveredByLlm;
        await withCap(
          triggerHit.locator.click({ timeout: 3_000 }).catch(() => undefined),
          4_000,
          undefined,
        );
        await page.waitForTimeout(500);
        // Try cascade again now that the input might be visible.
        inputHit = await findElement(page, ctx, {
          key: "searchInput",
          intent:
            "Após clicar no trigger de busca, encontrar o <input> de BUSCA que apareceu (não confundir com email/CEP).",
          budget,
          stepName: "find-search-input-after-trigger",
        });
        if (inputHit?.recoveredByLlm) inputRecoveredByLlm = true;
      }
    }
    if (!inputHit) {
      steps.push({
        ...makeSkipStep(
          2,
          "open-search",
          ctx,
          "search input not detected (incluindo recovery LLM)",
        ),
        actionDescription: "Não encontramos input de busca — flow skipado.",
      });
      reportEnd(2, "open-search", "skipped", Date.now() - t2, "search input not detected");
      // Try one more thing: navigate directly to /search?q=<term> for step 4.
      // But skip steps 3 (autocomplete) and 6 (empty state) gracefully.
      // Continue to step 4 below using URL-based search.
    } else {
      const recoverNote = [
        triggerRecoveredByLlm ? "trigger via LLM" : null,
        inputRecoveredByLlm ? "input via LLM" : null,
      ]
        .filter(Boolean)
        .join(", ");
      steps.push({
        step: 2,
        name: "open-search",
        side: ctx.side,
        viewport: ctx.viewport,
        status: "ok",
        durationMs: Date.now() - t2,
        screenshotPath: screenshotPath(ctx, "search-2-open"),
        selectorKey: "searchInput",
        usedSelector: inputHit.selector,
        recoveredByLlm: triggerRecoveredByLlm || inputRecoveredByLlm || undefined,
        actionDescription: usedTrigger
          ? `Clicou trigger \`${usedTrigger}\` e revelou input \`${inputHit.selector}\`${recoverNote ? ` (${recoverNote})` : ""}`
          : `Input de busca visível: \`${inputHit.selector}\`${recoverNote ? ` (${recoverNote})` : ""}`,
      });
      reportEnd(2, "open-search", "ok", Date.now() - t2);
      await screenshotStable(page, { path: screenshotPath(ctx, "search-2-open") });
    }

    // Step 3: type-and-autocomplete — type with delay, wait for suggestions
    reportStart(3, "type-and-autocomplete");
    const t3 = Date.now();
    let suggestionCount = 0;
    let autocompleteSelectorUsed: string | undefined;
    if (inputHit) {
      await withCap(
        inputHit.locator
          .pressSequentially(terms.withResults, { delay: typeDelayMs, timeout: 5_000 })
          .catch(() => undefined),
        Math.max(5_000, terms.withResults.length * (typeDelayMs + 50)),
        undefined,
      );
      // Wait for any suggestions container to appear; first to win.
      const suggestionSelectors = selFor(ctx, "searchSuggestions");
      for (const sel of suggestionSelectors) {
        try {
          const loc = page.locator(sel).first();
          const visible = await withCap(
            loc
              .waitFor({ state: "visible", timeout: 3_000 })
              .then(() => true)
              .catch(() => false),
            3_500,
            false,
          );
          if (visible) {
            autocompleteSelectorUsed = sel;
            // Count children that look like suggestion items.
            suggestionCount = await withCap(
              page
                .locator(`${sel} a, ${sel} li, ${sel} [role='option']`)
                .count()
                .catch(() => 0),
              1_500,
              0,
            );
            break;
          }
        } catch {
          /* try next */
        }
      }
    }
    const step3Status: StepCapture["status"] = inputHit
      ? "ok" // ok even without autocomplete — the check decides if absence is a regression
      : "skipped";
    steps.push({
      step: 3,
      name: "type-and-autocomplete",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step3Status,
      durationMs: Date.now() - t3,
      screenshotPath: screenshotPath(ctx, "search-3-autocomplete"),
      selectorKey: "searchSuggestions",
      usedSelector: autocompleteSelectorUsed,
      actionDescription: inputHit
        ? `Digitou "${terms.withResults}" e ${
            autocompleteSelectorUsed ? `viu ${suggestionCount} sugestões` : "não viu autocomplete"
          }`
        : "Sem input — autocomplete skipado.",
      searchValidation: {
        term: terms.withResults,
        mode: "autocomplete",
        suggestionCount,
      },
    });
    if (inputHit)
      await screenshotStable(page, { path: screenshotPath(ctx, "search-3-autocomplete") });
    reportEnd(3, "type-and-autocomplete", step3Status, Date.now() - t3);

    // Step 4: submit-results — press Enter or navigate URL-based
    reportStart(4, "submit-results");
    const t4 = Date.now();
    let resultsCap: PageCapture | null = null;
    if (inputHit) {
      // Submit via Enter
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined),
        inputHit.locator.press("Enter").catch(() => undefined),
      ]);
      // Wait a beat for the SPA to settle
      await page.waitForTimeout(1_000);
      resultsCap = await capturePage(page, {
        url: page.url(),
        side: ctx.side,
        viewport: ctx.viewport,
        screenshotPath: screenshotPath(ctx, "search-4-results"),
      });
    } else {
      // Fallback: navigate URL-based
      resultsCap = await capturePage(page, {
        url: searchUrlFor(ctx.baseUrl, terms.withResults),
        side: ctx.side,
        viewport: ctx.viewport,
        screenshotPath: screenshotPath(ctx, "search-4-results"),
      });
    }
    pages.push(resultsCap);
    const resultCount = await countProductCards(page);
    const step4Status: StepCapture["status"] =
      resultsCap.status >= 200 && resultsCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 4,
      name: "submit-results",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step4Status,
      durationMs: Date.now() - t4,
      url: resultsCap.finalUrl,
      screenshotPath: resultsCap.screenshotPath,
      actionDescription: `Submeteu busca "${terms.withResults}" — HTTP ${resultsCap.status}, ${resultCount} produtos detectados`,
      searchValidation: {
        term: terms.withResults,
        mode: "results",
        resultCount,
      },
    });
    reportEnd(4, "submit-results", step4Status, Date.now() - t4);

    // Step 5: search-no-results — exercise the empty state
    reportStart(5, "search-no-results");
    const t5 = Date.now();
    const noResultsCap = await capturePage(page, {
      url: searchUrlFor(ctx.baseUrl, terms.noResults),
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "search-5-no-results"),
    });
    pages.push(noResultsCap);
    // Wait for SPA hydration — VTEX Intelligent Search renders the empty-state
    // banner client-side after the SSR shell. Without this wait, innerText
    // and the per-page HTML both miss the "Nenhum resultado" message.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const nrResultCount = await countProductCards(page);
    const hasEmptyState = await detectNoResultsEmptyState(page, noResultsCap.html, terms.noResults);
    const step5Status: StepCapture["status"] =
      noResultsCap.status >= 200 && noResultsCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 5,
      name: "search-no-results",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step5Status,
      durationMs: Date.now() - t5,
      url: noResultsCap.finalUrl,
      screenshotPath: noResultsCap.screenshotPath,
      actionDescription: `Buscou termo unicode "${terms.noResults}" — ${nrResultCount} produtos, empty state ${hasEmptyState ? "visível" : "ausente"}`,
      searchValidation: {
        term: terms.noResults,
        mode: "no-results",
        resultCount: nrResultCount,
        hasEmptyState,
      },
    });
    reportEnd(5, "search-no-results", step5Status, Date.now() - t5);

    // Step 6: search-empty-state — /search with no query
    reportStart(6, "search-empty-state");
    const t6 = Date.now();
    const emptyCap = await capturePage(page, {
      url: new URL("/search", ctx.baseUrl).toString(),
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "search-6-empty"),
    });
    pages.push(emptyCap);
    const step6Status: StepCapture["status"] =
      emptyCap.status >= 200 && emptyCap.status < 500 ? "ok" : "failed";
    steps.push({
      step: 6,
      name: "search-empty-state",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step6Status,
      durationMs: Date.now() - t6,
      url: emptyCap.finalUrl,
      screenshotPath: emptyCap.screenshotPath,
      actionDescription: `Visitou /search sem query — HTTP ${emptyCap.status}`,
      searchValidation: {
        term: "",
        mode: "empty",
      },
    });
    reportEnd(6, "search-empty-state", step6Status, Date.now() - t6);
  } finally {
    await page.close().catch(() => undefined);
  }

  return { pages, steps };
}
