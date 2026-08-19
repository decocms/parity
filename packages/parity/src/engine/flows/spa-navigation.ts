import type { Locator, Page, Response } from "playwright";
import { extractSectionIds, normalizeSectionId } from "../../checks/lazy-sections.ts";
import { classify } from "../../diff/console.ts";
import type { ConsoleEntry, PageCapture, StepCapture } from "../../types/schema.ts";
import { capturePage } from "../collect.ts";
import type { FlowContext, FlowResult } from "./shared.ts";
import {
  captureInpSnapshot,
  findCategoryUrl,
  screenshotPath,
  screenshotStable,
  withCap,
} from "./shared.ts";

/**
 * SPA-navigation flow (issue #54, M2.5 — "C. SPA navigation mode").
 *
 * Parity today only ever does full page loads (`page.goto`). Issue #54's
 * recurring bug shape was "invisible on F5 but broke SPA navigation" —
 * site-globals/sections silently dropping, hydration mismatches, etc, all
 * only reproducible by navigating client-side (TanStack `<Link>`) between
 * two routes of the SAME site.
 *
 * This flow:
 *  1. Loads a category page via full F5.
 *  2. Finds ANOTHER same-origin nav link and CLICKS it (not `page.goto`) —
 *     if the site is a real client-side router this exercises SPA nav; if
 *     it isn't, the click just triggers a normal browser navigation, which
 *     is an honest, non-failing result (see `classifyNavigationType`).
 *  3. Compares "section marker" signals between the SPA-navigated render
 *     and a plain F5 of the identical destination URL. Fewer sections
 *     after the SPA nav is exactly the site-globals/section-drop bug
 *     class from issue #54.
 *
 * Caveat (documented per the M2.5 scope): there is no framework debug
 * bridge (`window.__DECO_LOADER_DATA__` / `window.__DECO_DEBUG__`) —
 * that's explicitly deferred post-1.0 in docs/ROADMAP-1.0.md. The section
 * signals used here are best-effort proxies:
 *   - network entries carrying an `x-deco-section` header or matching the
 *     `/deco/render|_loader` URL convention (same heuristic as
 *     `lazy-sections.ts`'s `extractSectionIds`)
 *   - DOM nodes carrying `[data-section]`/`[data-deco-section]` markers
 *     (same convention `src/extract/detect-components.ts` uses)
 * Neither is an exact "which CMS sections resolved" list — they're the
 * best signal available without framework cooperation.
 */

const STEP_NAMES = ["load-via-f5", "navigate-via-spa", "verify-section-parity"] as const;
const TOTAL_STEPS = STEP_NAMES.length;

/** Broad "any header/nav link" selector set — deliberately generic since
 *  we just need SOME same-origin link to a different route, not a specific
 *  navigation affordance. */
const NAV_LINK_SELECTORS: string[] = [
  "header a[href]",
  "nav a[href]",
  "[role='navigation'] a[href]",
  "[data-testid*='nav' i] a[href]",
  "[class*='menu' i] a[href]",
  "[class*='header' i] a[href]",
];

const SECTION_MARKER_SELECTOR = "[data-section], [data-deco-section]";

/**
 * Pure helper: pick the first candidate href whose PATH differs from the
 * current URL's path. Extracted so the "pick a different route" logic is
 * unit-testable without a browser — mirrors `pickDifferentProductHref` in
 * `cart-interactions.ts`.
 */
export function pickDifferentNavHref(hrefs: string[], currentUrl: string): string | null {
  const currentPath = safePathname(currentUrl);
  for (const href of hrefs) {
    const path = safePathname(href);
    if (path !== currentPath) return href;
  }
  return null;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/$/, "") || "/";
  } catch {
    return url;
  }
}

export type NavigationType = "spa" | "full-reload" | "no-navigation";

/**
 * Pure classifier for "what kind of navigation actually happened" after a
 * click. `markerSurvived` reflects whether a `window`-scoped marker set
 * BEFORE the click is still readable afterwards: a real full page load
 * destroys the JS execution context (marker gone); a client-side History
 * API navigation keeps it. This is a best-effort proxy — Playwright has no
 * direct "was this navigation a full reload" signal — but it's cheap and
 * has no false-positive path: the marker can only survive if the JS
 * context never got torn down.
 */
export function classifyNavigationType(params: {
  urlChanged: boolean;
  markerSurvived: boolean;
}): NavigationType {
  if (!params.urlChanged) return "no-navigation";
  return params.markerSurvived ? "spa" : "full-reload";
}

export interface SectionParityInput {
  f5NetworkSections: string[];
  f5DomCount: number;
  spaNetworkSections: string[];
  spaDomCount: number;
}

export interface SectionParityResult {
  /** True = the SPA-nav render had FEWER section markers than the F5 render of the same URL — the issue #54 bug class. */
  regression: boolean;
  f5Signal: number;
  spaSignal: number;
  signalSource: "network" | "dom";
}

/**
 * Pure comparison: does the SPA-navigated render show fewer sections than
 * a plain F5 of the identical destination URL? Prefers the network-marker
 * signal (more precise — tied to actual section fetches) when either side
 * produced any; falls back to the DOM structural-marker count otherwise
 * (e.g. sites that render everything inline with no lazy fetches at all).
 */
export function computeSectionParityRegression(input: SectionParityInput): SectionParityResult {
  const useNetwork = input.f5NetworkSections.length > 0 || input.spaNetworkSections.length > 0;
  const f5Signal = useNetwork ? input.f5NetworkSections.length : input.f5DomCount;
  const spaSignal = useNetwork ? input.spaNetworkSections.length : input.spaDomCount;
  return {
    regression: spaSignal < f5Signal,
    f5Signal,
    spaSignal,
    signalSource: useNetwork ? "network" : "dom",
  };
}

async function countSectionMarkerNodes(page: Page): Promise<number> {
  return withCap(
    page
      .evaluate((sel) => document.querySelectorAll(sel).length, SECTION_MARKER_SELECTOR)
      .catch(() => 0),
    1_500,
    0,
  );
}

async function collectNavLinkLocators(
  page: Page,
  selectors: string[],
  limit = 30,
): Promise<{ href: string; locator: Locator }[]> {
  const out: { href: string; locator: Locator }[] = [];
  const seenHrefs = new Set<string>();
  for (const sel of selectors) {
    if (out.length >= limit) break;
    try {
      const elements = page.locator(sel);
      const count = await elements.count();
      for (let i = 0; i < count && out.length < limit; i++) {
        const el = elements.nth(i);
        if (!(await el.isVisible({ timeout: 200 }).catch(() => false))) continue;
        const href = await el.getAttribute("href").catch(() => null);
        if (!href) continue;
        let abs: string;
        try {
          abs = new URL(href, page.url()).toString();
        } catch {
          continue;
        }
        if (seenHrefs.has(abs)) continue;
        seenHrefs.add(abs);
        out.push({ href: abs, locator: el });
      }
    } catch {
      /* try next selector */
    }
  }
  return out;
}

/**
 * Attach a lightweight, scoped `response` listener that records section-id
 * markers seen during a window of time (a click → SPA nav). Mirrors
 * `extractSectionIds`'s two rules (x-deco-section header, lazy-render URL
 * convention) without needing full `NetworkEntry` shape — we only care
 * about section ids here, not bytes/timing/etc.
 */
function attachSectionNetworkListener(page: Page): { stop: () => string[] } {
  const ids: string[] = [];
  const LAZY_URL_PATTERN = /\/(deco\/render|_loader)\b/;
  const listener = (resp: Response) => {
    try {
      const url = resp.url();
      const decoSection = resp.headers()["x-deco-section"];
      if (decoSection) {
        ids.push(normalizeSectionId(decoSection));
        return;
      }
      if (LAZY_URL_PATTERN.test(url)) {
        const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
        if (seg) ids.push(normalizeSectionId(seg));
      }
    } catch {
      /* ignore malformed entries */
    }
  };
  page.on("response", listener);
  return {
    stop: () => {
      page.off("response", listener);
      return ids;
    },
  };
}

export async function flowSpaNavigation(ctx: FlowContext): Promise<FlowResult> {
  const pages: PageCapture[] = [];
  const steps: StepCapture[] = [];
  const reportStart = (idx: number, name: string) =>
    ctx.onStep?.({ phase: "start", name, index: idx, total: TOTAL_STEPS });
  const reportEnd = (
    idx: number,
    name: string,
    status: StepCapture["status"],
    durationMs: number,
    note?: string,
  ) =>
    ctx.onStep?.({ phase: "end", name, index: idx, total: TOTAL_STEPS, status, durationMs, note });

  const home = await ctx.ctx.newPage();
  const homeCap = await capturePage(home, {
    url: ctx.baseUrl,
    side: ctx.side,
    viewport: ctx.viewport,
    screenshotPath: screenshotPath(ctx, "spa-nav-home"),
  });
  pages.push(homeCap);
  const plpHit = ctx.rc.plpUrlHint
    ? { url: new URL(ctx.rc.plpUrlHint, ctx.baseUrl).toString(), selector: "__hint__" }
    : await findCategoryUrl(home, ctx);
  await home.close();
  if (!plpHit) return { pages, steps };

  const page = await ctx.ctx.newPage();
  try {
    // Step 1: load-via-f5
    reportStart(1, "load-via-f5");
    const t1 = Date.now();
    const cap1 = await capturePage(page, {
      url: plpHit.url,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "spa-nav-f5-origin"),
    });
    pages.push(cap1);
    const domCount1 = await countSectionMarkerNodes(page);
    const networkSections1 = extractSectionIds(cap1.network);
    const errorCount1 = cap1.console.filter((c) => c.type === "error").length;
    steps.push({
      step: 1,
      name: "load-via-f5",
      side: ctx.side,
      viewport: ctx.viewport,
      status: cap1.status >= 400 ? "failed" : "ok",
      durationMs: Date.now() - t1,
      url: plpHit.url,
      screenshotPath: cap1.screenshotPath,
      detail: {
        networkSectionCount: networkSections1.size,
        domSectionCount: domCount1,
        consoleErrorCount: errorCount1,
      },
      actionDescription: `Categoria carregada via F5: ${plpHit.url} (network-sections=${networkSections1.size}, dom-sections=${domCount1})`,
    });
    reportEnd(1, "load-via-f5", cap1.status >= 400 ? "failed" : "ok", Date.now() - t1);
    if (cap1.status >= 400) {
      steps.push(skipStep(2, ctx, "load-via-f5 falhou — nada pra navegar"));
      steps.push(skipStep(3, ctx, "load-via-f5 falhou — nada pra verificar"));
      return { pages, steps };
    }

    // Step 2: navigate-via-spa
    reportStart(2, "navigate-via-spa");
    const t2 = Date.now();
    const beforeUrl = page.url();
    const navCandidates = await collectNavLinkLocators(page, NAV_LINK_SELECTORS, 30);
    const chosenHref = pickDifferentNavHref(
      navCandidates.map((c) => c.href),
      beforeUrl,
    );
    if (!chosenHref) {
      const note = "Nenhum link de navegação para uma rota diferente foi encontrado";
      steps.push({
        step: 2,
        name: "navigate-via-spa",
        side: ctx.side,
        viewport: ctx.viewport,
        status: "skipped",
        durationMs: Date.now() - t2,
        screenshotPath: "",
        note,
      });
      reportEnd(2, "navigate-via-spa", "skipped", Date.now() - t2, note);
      steps.push(skipStep(3, ctx, "sem navegação SPA para verificar"));
      return { pages, steps };
    }
    const chosen = navCandidates.find((c) => c.href === chosenHref);
    if (!chosen) {
      const note = "Link escolhido não pôde ser re-localizado (DOM mudou)";
      steps.push({
        step: 2,
        name: "navigate-via-spa",
        side: ctx.side,
        viewport: ctx.viewport,
        status: "skipped",
        durationMs: Date.now() - t2,
        screenshotPath: "",
        note,
      });
      reportEnd(2, "navigate-via-spa", "skipped", Date.now() - t2, note);
      steps.push(skipStep(3, ctx, "sem navegação SPA para verificar"));
      return { pages, steps };
    }

    // Marker set BEFORE the click — a real full page reload destroys the
    // JS execution context, so it can never be read back as true. A
    // client-side (History API) navigation preserves it.
    await page
      .evaluate(() => {
        (window as unknown as { __parity_nav_marker?: number }).__parity_nav_marker = Date.now();
      })
      .catch(() => undefined);

    const consoleDuringNav: ConsoleEntry[] = [];
    const onConsole = (msg: {
      type: () => string;
      text: () => string;
      location: () => { url?: string };
    }) => {
      const type = msg.type();
      if (
        type === "error" ||
        type === "warning" ||
        type === "log" ||
        type === "info" ||
        type === "debug"
      ) {
        consoleDuringNav.push({ type, text: msg.text(), location: msg.location()?.url });
      }
    };
    page.on("console", onConsole);
    const netListener = attachSectionNetworkListener(page);

    await withCap(
      chosen.locator.click({ timeout: 5_000 }).catch(() => undefined),
      5_000,
      undefined,
    );
    await withCap(
      page.waitForURL((u) => u.toString() !== beforeUrl, { timeout: 8_000 }).catch(() => undefined),
      8_000,
      undefined,
    );
    await page.waitForTimeout(1_000);

    page.off("console", onConsole);
    const spaNetworkSections = netListener.stop();

    const afterUrl = page.url();
    const urlChanged = afterUrl !== beforeUrl;
    const markerSurvived = await withCap(
      page
        .evaluate(
          () =>
            (window as unknown as { __parity_nav_marker?: number }).__parity_nav_marker !==
            undefined,
        )
        .catch(() => false),
      1_500,
      false,
    );
    const navType = classifyNavigationType({ urlChanged, markerSurvived });

    // The nav click just fired above is a real interaction. When it's a
    // genuine SPA nav (`markerSurvived`) the JS context — and with it
    // `window.__parity_vitals` — is the SAME one `cap1` was captured from,
    // so this is the only chance to read the INP it produced before
    // `capF5Dest` below does its own `page.goto` and reinstalls a fresh
    // collector on the destination document.
    await captureInpSnapshot(page, cap1);

    const hydrationEntries = consoleDuringNav.filter(
      (e) => e.type === "error" && classify(e) === "hydration",
    );

    const navScreenshot = screenshotPath(ctx, "spa-nav-after-click");
    await screenshotStable(page, { path: navScreenshot });

    const step2Status: StepCapture["status"] = navType === "no-navigation" ? "skipped" : "ok";
    const step2Note =
      navType === "no-navigation"
        ? "Click não navegou — link pode não ser um link de navegação real"
        : navType === "full-reload"
          ? "Navegação foi um full page reload (sem comportamento de SPA detectado)"
          : undefined;
    steps.push({
      step: 2,
      name: "navigate-via-spa",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step2Status,
      durationMs: Date.now() - t2,
      url: afterUrl,
      beforeUrl,
      screenshotPath: navScreenshot,
      note: step2Note,
      detail: {
        navigationType: navType,
        destUrl: afterUrl,
        hydrationErrorCount: hydrationEntries.length,
        hydrationSamples: hydrationEntries.slice(0, 3).map((e) => e.text),
      },
      actionDescription: `Click em link de navegação (${chosenHref}) — tipo detectado: ${navType}${
        hydrationEntries.length > 0 ? `, ${hydrationEntries.length} erro(s) de hidratação` : ""
      }`,
    });
    reportEnd(2, "navigate-via-spa", step2Status, Date.now() - t2, step2Note);

    if (navType !== "spa") {
      steps.push(
        skipStep(
          3,
          ctx,
          navType === "no-navigation"
            ? "sem destino para verificar — click não navegou"
            : "nenhum comportamento de SPA detectado — nada a comparar (site fez full navigation)",
        ),
      );
      return { pages, steps };
    }

    // Step 3: verify-section-parity
    reportStart(3, "verify-section-parity");
    const t3 = Date.now();
    const spaDomCount = await countSectionMarkerNodes(page);

    const capF5Dest = await capturePage(page, {
      url: afterUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "spa-nav-f5-dest"),
    });
    pages.push(capF5Dest);
    const f5DomCount = await countSectionMarkerNodes(page);
    const f5NetworkSections = extractSectionIds(capF5Dest.network);

    const parity = computeSectionParityRegression({
      f5NetworkSections: [...f5NetworkSections],
      f5DomCount,
      spaNetworkSections: [...new Set(spaNetworkSections)],
      spaDomCount,
    });

    const step3Status: StepCapture["status"] = parity.regression ? "failed" : "ok";
    const step3Note = parity.regression
      ? `SPA-nav render mostrou menos sections que F5 do mesmo destino (${parity.signalSource}: ${parity.spaSignal} < ${parity.f5Signal})`
      : undefined;
    steps.push({
      step: 3,
      name: "verify-section-parity",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step3Status,
      durationMs: Date.now() - t3,
      url: afterUrl,
      screenshotPath: capF5Dest.screenshotPath,
      note: step3Note,
      detail: {
        signalSource: parity.signalSource,
        spaSignal: parity.spaSignal,
        f5Signal: parity.f5Signal,
        regression: parity.regression,
      },
      actionDescription: parity.regression
        ? `Regressão de sections detectada — ${step3Note}`
        : `Paridade de sections OK (${parity.signalSource}: spa=${parity.spaSignal}, f5=${parity.f5Signal})`,
    });
    reportEnd(3, "verify-section-parity", step3Status, Date.now() - t3, step3Note);

    return { pages, steps };
  } finally {
    await page.close().catch(() => undefined);
  }
}

function skipStep(step: number, ctx: FlowContext, note: string): StepCapture {
  return {
    step,
    name: STEP_NAMES[step - 1] ?? `step-${step}`,
    side: ctx.side,
    viewport: ctx.viewport,
    status: "skipped",
    durationMs: 0,
    screenshotPath: "",
    note,
  };
}
