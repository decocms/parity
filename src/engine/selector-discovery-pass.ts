import ora from "ora";
import type { Browser } from "playwright";
import { discoverPlpFromHome } from "../checks/plp-pagination.ts";
import type { Platform } from "../learned/platform.ts";
import { type LearnedSelectors, SelectorKey, promoteFromLlm } from "../learned/repo.ts";
import {
  type DiscoveredSelectors,
  discoverSelectors,
  mergeDiscoveredSelectors,
  persistSelectorValidation,
} from "../llm/discover-selectors.ts";
import type { ParityRc, Viewport } from "../types/schema.ts";
import { launchBrowser, newContext, userAgentFor } from "./browser.ts";
import { validateSelectors } from "./validate-selectors.ts";

/**
 * Fetch a page's raw HTML with a viewport-appropriate User-Agent. Returns
 * `null` (never throws) on any network/HTTP error so callers can fall back to
 * defaults instead of aborting the whole run.
 */
export async function fetchHomeHtml(
  url: string,
  viewport: Viewport = "desktop",
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": userAgentFor(viewport),
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Find the first product-detail href in an already-fetched PLP HTML.
 *
 * Same two regex heuristics as `plp-pagination.ts`'s (unexported)
 * `fetchPlpProducts` — but that function ALSO does its own `fetch()` of
 * the PLP, which we don't want here (we already have the HTML in hand from
 * the discovery pre-fetch, and re-fetching would double the request for no
 * benefit). Duplicating ~10 lines of regex locally is cheaper and cleaner
 * than exporting a fetch-coupled helper across an unrelated module boundary
 * just to reuse it.
 */
export function firstProductHrefFromPlpHtml(html: string, baseUrl: string): string | null {
  const patterns = [/href="([^"]+\/p(?:\?[^"]*|\/[^"]+|))"/i, /href="([^"]+\/products\/[^"]+)"/i];
  for (const re of patterns) {
    const match = re.exec(html);
    const href = match?.[1];
    if (href) {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        /* try next pattern */
      }
    }
  }
  return null;
}

/**
 * Live-validation pass for freshly-discovered selectors (M4). Launches a
 * throwaway headless browser context, navigates to whichever of home/PLP/PDP
 * were fetched, and probes the keys relevant to each page. Returns `null`
 * (never throws) when the throwaway browser itself fails to launch — a
 * validation failure should never take down the whole run.
 */
type SelectorStringKey = Exclude<keyof DiscoveredSelectors, "lowConfidenceKeys">;
const HOME_VALIDATION_KEYS = [
  "categoryLink",
  "minicartTrigger",
  "searchTrigger",
  "searchInput",
  "loginTrigger",
  "accountMenuTrigger",
] as const satisfies readonly SelectorStringKey[];
const PLP_VALIDATION_KEYS = ["productCard"] as const satisfies readonly SelectorStringKey[];
const PDP_VALIDATION_KEYS = [
  "buyButton",
  "cepInputPdp",
  "pdpGalleryThumbnail",
  "pdpGalleryMain",
  "pdpRelatedShelf",
  // Journey-critical variant/quantity keys (issue #141) — present on the PDP,
  // so live-validation can confirm them before they're trusted/promoted.
  "variantRow",
  "quantityIncrement",
  "quantityInput",
  "sizeSwatch",
  "colorSwatch",
] as const satisfies readonly SelectorStringKey[];

function pickSelectorSubset(
  selectors: DiscoveredSelectors,
  keys: readonly SelectorStringKey[],
): DiscoveredSelectors {
  const subset: DiscoveredSelectors = {};
  for (const key of keys) {
    const value = selectors[key];
    if (typeof value === "string") subset[key] = value;
  }
  return subset;
}

async function runLiveSelectorValidation(
  discovered: DiscoveredSelectors,
  ctx: { homeUrl: string; plpUrl?: string; pdpUrl?: string; viewport: Viewport },
): Promise<{
  validated: Partial<Record<keyof DiscoveredSelectors, boolean>>;
  failed: (keyof DiscoveredSelectors)[];
} | null> {
  let browser: Browser | null = null;
  try {
    browser = await launchBrowser({ headless: true });
    const context = await newContext(browser, { viewport: ctx.viewport });
    const page = await context.newPage();

    const validated: Partial<Record<keyof DiscoveredSelectors, boolean>> = {};
    const failed = new Set<keyof DiscoveredSelectors>();

    const runOn = async (url: string, keys: readonly SelectorStringKey[]) => {
      const subset = pickSelectorSubset(discovered, keys);
      if (Object.keys(subset).length === 0) return;
      try {
        await page.goto(url, { waitUntil: "load", timeout: 20_000 });
        // Client-hydrated sites (TanStack/Deco, VTEX IO) render product
        // grids, buy buttons and galleries AFTER JS runs — probing at
        // `domcontentloaded` would see 0 elements and wrongly discard a
        // perfectly good selector (observed on the montecarlo TanStack build,
        // issue #141). Let the network settle so hydration completes before
        // we probe; bounded + best-effort so a chatty analytics page can't
        // stall the pass.
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      } catch {
        // Navigation failed — nothing to validate against; leave these keys
        // unvalidated (neither true nor false) rather than force a false
        // negative for a page-load problem unrelated to the selector.
        return;
      }
      const result = await validateSelectors(page, subset);
      Object.assign(validated, result.validated);
      for (const key of result.failed) failed.add(key);
    };

    await runOn(ctx.homeUrl, HOME_VALIDATION_KEYS);
    if (ctx.plpUrl) await runOn(ctx.plpUrl, PLP_VALIDATION_KEYS);
    if (ctx.pdpUrl) await runOn(ctx.pdpUrl, PDP_VALIDATION_KEYS);

    await context.close();
    return { validated, failed: Array.from(failed) };
  } catch (err) {
    console.warn(`[selectors] live-validation falhou (não-fatal): ${(err as Error).message}`);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export interface SelectorDiscoveryPassOptions {
  /** Site to discover selectors against (prod for `run`, cand for `e2e`). */
  url: string;
  /** Viewport used for HTML fetch + live-validation. */
  viewport: Viewport;
  /** Mutated in place: discovered selectors merged into `rc.selectors`. */
  rc: ParityRc;
  /** Mutated in place: discovered selectors seeded into the learned library. */
  learned: LearnedSelectors;
  /** Detected platform for the URL — keys the learned-selector seeding. */
  platform: Platform;
  /** Hostname of `url` — confirmed-host tracking on learned entries. */
  host: string;
  /** Bypass the discovery cache and re-run against the LLM. */
  refreshSelectors?: boolean;
  /** Pre-fetched home HTML (from a preflight fetch) to avoid a second GET. */
  homeHtml?: string | null;
  /** Suppress the spinner (e.g. `--json` mode). */
  quiet?: boolean;
}

/**
 * Shared LLM selector-discovery pass used by both `parity run` and
 * `parity e2e`. Grounds PDP/PLP-only keys in REAL markup (pre-fetches a PLP
 * then a PDP off the home), asks the LLM, live-validates each selector in a
 * throwaway browser, merges surviving ones into `rc.selectors` (user
 * `.parityrc.json` overrides always win — see `mergeDiscoveredSelectors`),
 * and seeds `learned-selectors.json` (verified only when the selector both
 * live-validated AND the model itself wasn't unsure about it).
 *
 * Extracted verbatim from `run.ts` so single-site `e2e` gets the same
 * automation instead of only DEFAULT_SELECTORS + hand-written overrides
 * (issue #141). Mutates `rc` and `learned` in place; never throws.
 */
export async function runSelectorDiscoveryPass(
  opts: SelectorDiscoveryPassOptions,
): Promise<void> {
  const { url, viewport, rc, learned, platform, host } = opts;
  const spinner = opts.quiet
    ? null
    : ora("Descobrindo seletores via LLM (analisando home/PLP/PDP)…").start();
  const warn = (msg: string) => {
    if (spinner) spinner.warn(msg);
    else console.warn(`[selectors] ${msg}`);
  };
  try {
    const html = opts.homeHtml ?? (await fetchHomeHtml(url, viewport));
    if (!html) {
      warn("Falha ao baixar HTML da home; usando defaults");
      return;
    }

    // M4: ground PDP/PLP-only selector keys (buyButton, pdpGallery*,
    // productCard, variantRow, …) in REAL markup instead of asking the LLM to
    // infer PDP/PLP convention from the home page alone. All plain `fetch()`
    // — the PLP→PDP hop is inherently sequential (need PLP HTML to find a
    // product href), so there's nothing to parallelize here.
    let plpUrl: string | undefined;
    let plpHtml: string | undefined;
    let pdpUrl: string | undefined;
    let pdpHtml: string | undefined;
    try {
      const foundPlpUrl = await discoverPlpFromHome(url);
      if (foundPlpUrl) {
        plpUrl = foundPlpUrl;
        plpHtml = (await fetchHomeHtml(foundPlpUrl, viewport)) ?? undefined;
        if (plpHtml) {
          const foundPdpUrl = firstProductHrefFromPlpHtml(plpHtml, foundPlpUrl);
          if (foundPdpUrl) {
            pdpUrl = foundPdpUrl;
            pdpHtml = (await fetchHomeHtml(foundPdpUrl, viewport)) ?? undefined;
          }
        }
      }
    } catch (err) {
      console.warn(
        `[discover-selectors] PLP/PDP pre-fetch falhou (não-fatal): ${(err as Error).message}`,
      );
    }

    const discovered = await discoverSelectors(
      { home: url, plp: plpUrl, pdp: pdpUrl },
      { home: html, plp: plpHtml, pdp: pdpHtml },
      { noCache: opts.refreshSelectors === true },
    );
    if (!discovered) {
      warn("LLM não retornou seletores; usando defaults");
      return;
    }

    const added = Object.entries(discovered).filter(
      ([k, v]) => k !== "lowConfidenceKeys" && v,
    ).length;
    if (spinner) spinner.text = `${added} seletor(es) inferido(s) pelo LLM — validando ao vivo…`;

    // Live-validation pass (M4): a short-lived, throwaway browser context —
    // closed right after — confirms each selector matches ≥1 element on the
    // page it's supposed to live on before it's trusted enough to (a) survive
    // into rc.selectors and (b) seed learned-selectors at `verified`.
    const validation = await runLiveSelectorValidation(discovered, {
      homeUrl: url,
      plpUrl,
      pdpUrl,
      viewport,
    });

    if (validation) {
      persistSelectorValidation(url, validation.validated);
      for (const key of validation.failed) {
        console.warn(
          `[selectors] descartando "${key}" — falhou na validação ao vivo (0 elementos na página onde deveria estar)`,
        );
        discovered[key] = undefined;
      }
    }

    mergeDiscoveredSelectors(rc.selectors, discovered);

    // Seed learned-selectors immediately from this discovery, ahead of any
    // flow running: verified confidence ONLY when the selector both
    // live-validated AND the model itself wasn't flagged as unsure about it
    // (`low_confidence_keys`) — a selector can validate as "found 1 element"
    // and still be semantically wrong.
    const lowConfidence = new Set(discovered.lowConfidenceKeys ?? []);
    for (const key of Object.keys(discovered) as (keyof DiscoveredSelectors)[]) {
      if (key === "lowConfidenceKeys") continue;
      const selector = discovered[key];
      if (!selector) continue;
      const parsedKey = SelectorKey.safeParse(key);
      if (!parsedKey.success) continue;
      const isVerified = validation?.validated[key] === true && !lowConfidence.has(key);
      promoteFromLlm(learned, platform, parsedKey.data, selector, host, isVerified);
    }

    const validatedCount = validation
      ? Object.values(validation.validated).filter(Boolean).length
      : 0;
    if (spinner)
      spinner.succeed(
        `${added} seletor(es) inferido(s) pelo LLM (${validatedCount} validado(s) ao vivo)`,
      );
  } catch (err) {
    warn(`Discovery falhou: ${(err as Error).message}`);
  }
}
