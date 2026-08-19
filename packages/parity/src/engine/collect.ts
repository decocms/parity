import type { BrowserContext, Page, Response } from "playwright";
import type {
  ConsoleEntry,
  NetworkEntry,
  PageCapture,
  Side,
  Viewport,
  WebVitals,
  WebVitalsStats,
  WebVitalStat,
} from "../types/schema.ts";
import { stabilizeCarousels } from "./carousel-stabilizer.ts";

const DEBUG_PARITY = process.env.DEBUG_PARITY === "1" || process.env.DEBUG_PARITY === "true";
const DEBUG_START = Date.now();
function dlog(side: Side, viewport: Viewport, msg: string): void {
  if (!DEBUG_PARITY) return;
  const elapsed = ((Date.now() - DEBUG_START) / 1000).toFixed(1);
  process.stderr.write(`[+${elapsed}s ${viewport}/${side}] ${msg}\n`);
}

/**
 * CLS session-windowing reducer: max 5s window with <=1s gaps between
 * shifts, per spec (https://github.com/GoogleChrome/web-vitals/blob/main/src/onCLS.ts) —
 * not a lifetime cumulative sum. Exported for unit testing; its source is
 * inlined verbatim into VITALS_INIT_SCRIPT below via toString() so the
 * in-browser collector runs the exact same code this is tested against.
 */
export function clsWindowReducer(
  state: { sessionValue: number; sessionStart: number; sessionLast: number; clsValue: number },
  entry: { startTime: number; value: number; hadRecentInput: boolean },
): typeof state {
  if (entry.hadRecentInput) return state;
  let { sessionValue, sessionStart, sessionLast, clsValue } = state;
  if (
    sessionValue &&
    entry.startTime - sessionLast < 1000 &&
    entry.startTime - sessionStart < 5000
  ) {
    sessionValue += entry.value;
  } else {
    sessionValue = entry.value;
    sessionStart = entry.startTime;
  }
  sessionLast = entry.startTime;
  if (sessionValue > clsValue) clsValue = sessionValue;
  return { sessionValue, sessionStart, sessionLast, clsValue };
}

/**
 * Inline collector that runs inside the page to capture Core Web Vitals
 * via PerformanceObserver. Uses a window-attached object that we read
 * via page.evaluate after navigation settles.
 */
const VITALS_INIT_SCRIPT = `
  (function() {
    if (window.__parity_vitals_installed) return;
    window.__parity_vitals_installed = true;
    window.__parity_vitals = { lcp: null, cls: 0, fcp: null, ttfb: null, inp: null };

    // TTFB
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) window.__parity_vitals.ttfb = nav.responseStart;
    } catch (e) {}

    // LCP
    try {
      new PerformanceObserver(function(list) {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) window.__parity_vitals.lcp = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (e) {}

    // FCP
    try {
      new PerformanceObserver(function(list) {
        for (const e of list.getEntries()) {
          if (e.name === 'first-contentful-paint') {
            window.__parity_vitals.fcp = e.startTime;
          }
        }
      }).observe({ type: 'paint', buffered: true });
    } catch (e) {}

    // CLS
    try {
      const clsWindowReducer = ${clsWindowReducer.toString()};
      let clsState = { sessionValue: 0, sessionStart: 0, sessionLast: 0, clsValue: 0 };
      new PerformanceObserver(function(list) {
        for (const entry of list.getEntries()) {
          clsState = clsWindowReducer(clsState, entry);
          window.__parity_vitals.cls = clsState.clsValue;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (e) {}

    // INP (event-timing approximation, takes max event duration)
    try {
      let worstInp = 0;
      new PerformanceObserver(function(list) {
        for (const entry of list.getEntries()) {
          const d = entry.duration || 0;
          if (d > worstInp) {
            worstInp = d;
            window.__parity_vitals.inp = worstInp;
          }
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    } catch (e) {}
  })();
`;

export async function installVitalsCollector(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript({ content: VITALS_INIT_SCRIPT });
}

/**
 * One extra vitals-only navigation for `CaptureOptions.runs` (issue #179).
 * Runs in a throwaway page on the same context (which already has the
 * vitals init script from `installVitalsCollector`) so it doesn't pollute
 * the primary page's console/network collectors with a second navigation's
 * worth of requests.
 */
async function captureVitalsSample(
  context: BrowserContext,
  url: string,
  timeoutMs: number,
): Promise<WebVitals | null> {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => undefined);
    await page
      .waitForLoadState("networkidle", { timeout: Math.min(4_000, timeoutMs) })
      .catch(() => undefined);
    await page.waitForTimeout(300).catch(() => undefined);
    return (
      (await Promise.race([
        page
          .evaluate(() => (window as unknown as { __parity_vitals?: WebVitals }).__parity_vitals)
          .catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
      ])) ?? null
    );
  } finally {
    await page.close().catch(() => undefined);
  }
}

const VITALS_METRICS = ["lcp", "cls", "fcp", "ttfb", "inp"] as const;

/**
 * Aggregate raw per-run vitals samples into median/p75/min/max per metric.
 * `null` values are dropped before aggregating (a metric that never fired
 * on a given run, e.g. INP with no interaction) — a metric is `null` in the
 * result only if it never resolved on ANY run. Exported for unit testing.
 */
export function aggregateVitalsSamples(samples: WebVitals[]): WebVitalsStats {
  const out = {} as WebVitalsStats;
  for (const metric of VITALS_METRICS) {
    const values = samples.map((s) => s[metric]).filter((v): v is number => v != null);
    out[metric] = values.length > 0 ? statFor(values) : null;
  }
  return out;
}

function statFor(raw: number[]): WebVitalStat {
  const sorted = [...raw].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    samples: raw,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

/**
 * Read `window.__parity_vitals` off `page` as-is — no navigation, no wait.
 * Safe to call mid-flow, right after a real interaction (click, keypress),
 * as long as the page hasn't navigated since the vitals collector was last
 * installed on it.
 *
 * `capturePage()` calls this immediately after its own `page.goto()`, which
 * historically was the ONLY place anything ever read this back out — so
 * `inp` (which only populates from real user interactions, never from
 * navigation) was structurally always `null` (issue #184). Flow steps that
 * click something mid-visit should call this afterward and merge the result
 * with {@link mergeInpSnapshot} instead of relying on the next `capturePage`
 * call, which navigates first and wipes the interaction history.
 */
export async function readVitalsSnapshot(page: Page): Promise<WebVitals | null> {
  return (
    (await page
      .evaluate(() => (window as unknown as { __parity_vitals?: WebVitals }).__parity_vitals)
      .catch(() => null)) ?? null
  );
}

/**
 * Merge a mid-flow vitals snapshot's `inp` into an already-captured
 * `WebVitals`, taking the larger value. Only `inp` is merged — LCP/CLS/FCP/
 * TTFB are paint-timing metrics tied to the specific document `capturePage`
 * already read at goto-time; re-reading them later (possibly after an SPA
 * nav swapped routes, or a reload reinstalled the collector on a new
 * document) risks misattributing them to the wrong page. INP is the one
 * metric that's genuinely dead without a post-interaction read (issue #184).
 */
export function mergeInpSnapshot(vitals: WebVitals, snapshot: WebVitals | null): WebVitals {
  if (snapshot?.inp == null) return vitals;
  if (vitals.inp != null && vitals.inp >= snapshot.inp) return vitals;
  return { ...vitals, inp: snapshot.inp };
}

/**
 * Chromium error codes that mean "the request was canceled, not a real
 * failure". `ERR_ABORTED` fires when the page navigates away before an
 * async request resolved — typical for tracking pixels in the
 * fast multi-page vitals crawler (issue #40). `ERR_NETWORK_CHANGED`
 * fires when the OS changes networks mid-request. Neither indicates a
 * problem with the site under test.
 *
 * Exported so audit/check checks can use the same allowlist if they
 * ever process raw error strings.
 */
export const CANCELLATION_ERROR_CODES: ReadonlyArray<string> = [
  "net::ERR_ABORTED",
  "net::ERR_NETWORK_CHANGED",
];

export function isCancellationError(errorText: string): boolean {
  return CANCELLATION_ERROR_CODES.some((code) => errorText.includes(code));
}

/**
 * URL substring patterns for third-party tracking endpoints that fire
 * async, beacon-style requests after page load. When these get canceled
 * by a navigation, they're not actionable for site quality — the user's
 * site is fine; the pixel just didn't finish reporting. Safety net for
 * cases where Playwright reports a different errorText (e.g. `ERR_FAILED`
 * instead of `ERR_ABORTED`) but the underlying cause is the same.
 *
 * Conservative list: only well-known fire-and-forget pixels where
 * failure is never useful to the developer auditing site quality. Real
 * tracking failures that DO matter (e.g. checkout SDK errors) won't
 * match any of these substrings.
 *
 * Exported so the audit's network check can also skip these when
 * counting third-party errors.
 */
export const KNOWN_ASYNC_TRACKING_URL_PATTERNS: ReadonlyArray<string> = [
  "google.com/ccm/collect",
  "google.com/rmkt/collect",
  "google-analytics.com/g/collect",
  "google-analytics.com/collect",
  "facebook.com/tr",
  "facebook.net/signals",
  "liadm.com/s/",
  "revcontent.com/cm/pixel",
  "criteo.com/delivery",
  "criteo.net/delivery",
  "doubleclick.net/pagead",
  "voxus.tv/pixel",
];

export function isKnownAsyncTrackingUrl(url: string): boolean {
  return KNOWN_ASYNC_TRACKING_URL_PATTERNS.some((pattern) => url.includes(pattern));
}

export interface CollectorState {
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

/** Attach console + network listeners to a page. Returns the accumulator. */
export function attachCollectors(page: Page): CollectorState {
  const state: CollectorState = { console: [], network: [] };

  page.on("console", (msg) => {
    const type = msg.type();
    if (
      type !== "error" &&
      type !== "warning" &&
      type !== "log" &&
      type !== "info" &&
      type !== "debug"
    ) {
      return;
    }
    state.console.push({
      type,
      text: msg.text(),
      location: msg.location()?.url,
    });
  });

  page.on("pageerror", (err) => {
    state.console.push({
      type: "error",
      text: err.message,
      location: err.stack?.split("\n")[1]?.trim(),
    });
  });

  page.on("requestfailed", (req) => {
    const errorText = req.failure()?.errorText ?? "unknown";
    // Issue #40: async tracking pixels (Google Ads, Criteo, LiveIntent,
    // GTM-fired beacons) get canceled by the next navigation in the
    // fast multi-page vitals crawler — Playwright reports those as
    // `net::ERR_ABORTED` (or `net::ERR_NETWORK_CHANGED`). They are NOT
    // real failures: the same URLs complete with 200 in the main
    // purchase-journey flow where the page stays loaded long enough.
    // The HAR still records the abort for forensics; we just don't
    // promote it to a console error that becomes a high-severity
    // issue downstream.
    if (isCancellationError(errorText) || isKnownAsyncTrackingUrl(req.url())) {
      return;
    }
    state.console.push({
      type: "error",
      text: `[request-failed] ${req.url()} — ${errorText}`,
    });
  });

  const responseQueue: Promise<void>[] = [];
  page.on("response", (resp) => {
    responseQueue.push(
      (async () => {
        const entry = await responseToEntry(resp);
        state.network.push(entry);
      })().catch(() => {
        /* ignore individual entry errors */
      }),
    );
  });

  // Expose flush for the caller
  (state as CollectorState & { __flush?: () => Promise<void> }).__flush = async () => {
    await Promise.allSettled(responseQueue);
  };

  return state;
}

/**
 * Wait for response promises to settle, but bail out after `timeoutMs` to
 * avoid hanging on streaming responses (SSE, long-poll, websockets) whose
 * `body()` never resolves until the page closes.
 */
export async function flushCollectors(state: CollectorState, timeoutMs = 5_000): Promise<void> {
  const flush = (state as CollectorState & { __flush?: () => Promise<void> }).__flush;
  if (!flush) return;
  await Promise.race([flush(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

async function responseToEntry(resp: Response): Promise<NetworkEntry> {
  const req = resp.request();
  const headers = resp.headers();
  const timing = req.timing();
  // Prefer the `content-length` header over reading the body. Calling
  // `resp.body()` forces Chromium to materialize the ENTIRE response body
  // (images, fonts, video, …) and copy it into the Node heap — done for every
  // response of every page, across up to 4 concurrent contexts, it was one of
  // the largest drivers of RSS and pushed machines into the OOM killer. Only
  // fall back to `body()` for small text resources whose byte count actually
  // matters downstream (HTML/JS/XHR) and only when the header is absent; never
  // buffer binary assets just to count bytes.
  const contentLength = parseIntOrNull(headers["content-length"]);
  const bytes =
    contentLength ??
    (isSmallTextResource(req.resourceType()) ? await safeBodySize(resp) : null);
  return {
    url: resp.url(),
    method: req.method(),
    status: resp.status(),
    resourceType: req.resourceType(),
    fromCache: resp.fromServiceWorker() || isFromHttpCache(resp),
    bytes,
    durationMs: timing.responseEnd > 0 ? timing.responseEnd - timing.requestStart : null,
    // Page-relative request timing. `startTime` is the absolute ms since
    // unix epoch; we use `requestStart` (relative to navigation) for a
    // proper waterfall scoped to the page. Issue #78.
    startMs: timing.requestStart >= 0 ? timing.requestStart : null,
    endMs: timing.responseEnd > 0 ? timing.responseEnd : null,
    cacheControl: headers["cache-control"] ?? null,
    serverTiming: headers["server-timing"] ?? null,
    decoSection: headers["x-deco-section"] ?? null,
  };
}

/**
 * Resource types whose exact byte size is worth reading from the body when the
 * `content-length` header is missing (chunked/streamed text). Binary assets
 * (image/media/font/stylesheet) are excluded — buffering them just to count
 * bytes is the memory cost we're avoiding.
 */
function isSmallTextResource(resourceType: string): boolean {
  return (
    resourceType === "document" ||
    resourceType === "script" ||
    resourceType === "xhr" ||
    resourceType === "fetch"
  );
}

async function safeBodySize(resp: Response): Promise<number | null> {
  try {
    const buf = await Promise.race([
      resp.body(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000)),
    ]);
    if (!buf) return null;
    return buf.byteLength;
  } catch {
    return null;
  }
}

function parseIntOrNull(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Scroll the page from top to bottom in steps to trigger lazy-loaded images,
 * sections, and analytics. Returns to top at the end so screenshots start
 * from header (full-page screenshot stitches the whole height regardless).
 */
/**
 * Selectors that strongly indicate a skeleton/loader placeholder. Captures
 * a broad set of conventions: Tailwind `.animate-pulse`, classic `.skeleton`,
 * `react-loading-skeleton`, `[aria-busy]`, and the common Deco/VTEX shelf
 * placeholders that block real content from rendering during fetch.
 */
export const SKELETON_SELECTOR =
  "[aria-busy='true'],[data-skeleton],[data-loading='true'],.skeleton,[class*='skeleton' i],[class*='Skeleton'],[class*='shimmer' i],.animate-pulse,.placeholder-shimmer,.react-loading-skeleton";

/**
 * Poll the page until skeleton placeholders disappear (or `maxMs` elapses).
 *
 * Heavy storefronts (VTEX intelligent search shelves, Shopify collection
 * grids, Deco lazy sections) commonly render skeleton cards while the data
 * fetch is in flight. If we screenshot too early we capture a forest of
 * placeholders, and the visual-diff LLM downstream then reports phantom
 * "missing-component" diffs because one side raced ahead.
 *
 * We poll every 500ms — `setInterval` would be cheaper, but the polling
 * loop is bounded by `maxMs` and runs at most ~12 iterations so the
 * overhead is negligible compared to a 30s+ page capture.
 */
export async function waitForSkeletonsToResolve(page: Page, maxMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const count = await page
      .evaluate((sel) => document.querySelectorAll(sel).length, SKELETON_SELECTOR)
      .catch(() => 0);
    if (count === 0) return;
    await page.waitForTimeout(500).catch(() => undefined);
  }
}

/**
 * Result returned by `scrollFullPage` so the caller can log diagnostics
 * (final scroll height, step count, whether budget was exhausted).
 */
export interface ScrollFullPageResult {
  steps: number;
  finalHeight: number;
  stableAtEnd: boolean;
  durationMs: number;
}

/**
 * Scroll the page top-to-bottom triggering IntersectionObserver-gated lazy
 * sections (VTEX intelligent search shelves, Shopify collection grids,
 * deferred hero banners), then return to top. Returns when the page stops
 * growing in height (stable for `STABLE_THRESHOLD` consecutive checks) or
 * the time budget is exhausted.
 *
 * **Why adaptive instead of fixed-step:** earlier versions of this function
 * scrolled N fixed steps and bailed on a timer. Two failure modes that
 * users hit on real storefronts:
 *
 *  - **Fixed-step too short on growing pages.** The old code read
 *    `scrollHeight` once at the start. As lazy sections hydrated, the page
 *    grew past that value, but the loop had already exited — screenshots
 *    captured `header + half the page + dead space`.
 *  - **Fixed budget too short for slow APIs.** A 10s wrapping race left
 *    only 25 ticks × 600px = 15000px reachable; real e-commerce homes
 *    routinely render 25000–40000px, so we never reached the bottom.
 *
 * The adaptive version:
 *  - Re-measures `scrollHeight` every tick (catches growth)
 *  - Waits inline for in-view skeleton placeholders to clear per step
 *    (lets each shelf land its fetch before scrolling past)
 *  - Exits cleanly once the page is stable AND we've reached the bottom
 *  - Bounded by `budgetMs` so a misbehaved infinite-feed page can't hang
 */
export async function scrollFullPage(page: Page, budgetMs = 45_000): Promise<ScrollFullPageResult> {
  const start = Date.now();
  // ⚠️ Everything inside `page.evaluate` runs in the BROWSER's JS context —
  // Playwright sends the function as a string. tsx/esbuild inject a `__name`
  // helper when you declare named arrow functions (`const foo = () => ...`)
  // to preserve `.name` for stack traces. That helper doesn't exist in the
  // page, so the function fails with `ReferenceError: __name is not defined`
  // and `.catch` eats it silently. Bug history shows this exact failure
  // pattern took two debug rounds to isolate — avoid named arrow consts
  // here and inline the work directly.
  const result = await page.evaluate(async (budget: number) => {
    // SKELETON_SELECTOR_INLINE — keep in sync with module-level SKELETON_SELECTOR
    const SK =
      "[aria-busy='true'],[data-skeleton],[data-loading='true'],.skeleton,[class*='skeleton' i],[class*='Skeleton'],[class*='shimmer' i],.animate-pulse,.placeholder-shimmer,.react-loading-skeleton";
    const innerStart = Date.now();

    let y = 0;
    let prevHeight = 0;
    let stableTicks = 0;
    let steps = 0;
    const STABLE_THRESHOLD = 3;

    while (budget - (Date.now() - innerStart) > 2000) {
      window.scrollTo(0, y);
      steps++;
      await new Promise<void>((r) => setTimeout(r, 400));

      // Inter-step skeleton wait — give this section's lazy fetch a chance
      // to land BEFORE we scroll past. Cap per step at 1500ms.
      const stepWaitStart = Date.now();
      while (
        document.querySelectorAll(SK).length > 0 &&
        Date.now() - stepWaitStart < 1500 &&
        budget - (Date.now() - innerStart) > 1000
      ) {
        await new Promise<void>((r) => setTimeout(r, 200));
      }

      const height = document.documentElement.scrollHeight;
      const viewport = window.innerHeight;
      if (y + viewport >= height - 50) {
        if (height === prevHeight) {
          stableTicks++;
          if (stableTicks >= STABLE_THRESHOLD) break;
        } else {
          stableTicks = 0;
          prevHeight = height;
        }
        await new Promise<void>((r) => setTimeout(r, 500));
      } else {
        y = Math.min(y + Math.max(viewport * 0.8, 600), height);
      }
    }

    const finalHeight = document.documentElement.scrollHeight;
    window.scrollTo(0, finalHeight);
    await new Promise<void>((r) => setTimeout(r, 1500));
    window.scrollTo(0, 0);
    await new Promise<void>((r) => setTimeout(r, 700));

    return { steps, finalHeight, stableAtEnd: stableTicks >= STABLE_THRESHOLD };
  }, budgetMs);

  return {
    steps: result.steps,
    finalHeight: result.finalHeight,
    stableAtEnd: result.stableAtEnd,
    durationMs: Date.now() - start,
  };
}

function isFromHttpCache(resp: Response): boolean {
  // Playwright doesn't expose fromCache directly; infer from CF header or x-cache.
  const h = resp.headers();
  const cfStatus = h["cf-cache-status"]?.toLowerCase();
  if (cfStatus === "hit" || cfStatus === "stale" || cfStatus === "revalidated") return true;
  const xCache = h["x-cache"]?.toLowerCase();
  if (xCache?.startsWith("hit")) return true;
  return false;
}

export interface CaptureOptions {
  url: string;
  side: Side;
  viewport: Viewport;
  screenshotPath: string;
  /**
   * Logical key this capture pairs on, when prod and cand sit at different
   * paths. Pass the SAME value for both sides. Omit when the paths match —
   * pairing then falls back to the URL pathname.
   */
  pairKey?: string;
  harPath?: string;
  tracePath?: string;
  /** Settle delay after networkidle, in ms. Default 2500 to let hydration finish. */
  settleMs?: number;
  /** Hard timeout for navigation. Default 30s. */
  timeoutMs?: number;
  /** Auto-scroll page through full height before screenshot to force lazy-loading. Default true. */
  scrollToLoad?: boolean;
  /** Skip the full-page screenshot (saves time when only metrics are needed). Default false. */
  skipScreenshot?: boolean;
  /** Skip the heavy waitForLoadState('load'). Default false. Set true for vitals-only / cache-only captures. */
  fast?: boolean;
  /**
   * Skip every `waitForLoadState("networkidle")` inside the capture pipeline.
   * Use this when targeting Vite/Webpack dev servers — their HMR / SSE
   * channels never let networkidle fire, hanging the capture indefinitely.
   * Issue #55. The Promise.race outer deadline still applies as a safety net.
   */
  noNetworkIdle?: boolean;
  /**
   * Repeat the vitals-collecting navigation this many times (in throwaway
   * pages on the same context) and aggregate median/p75/min/max per metric
   * into `vitalsStats`, with `vitals` itself becoming the per-metric median.
   * Screenshot/console/network/HTML capture stay single-run — only the
   * lightweight vitals read is repeated. Default 1 (no repeat). Issue #179.
   */
  runs?: number;
}

export async function capturePage(page: Page, opts: CaptureOptions): Promise<PageCapture> {
  const start = Date.now();
  const state = attachCollectors(page);
  /** Hard total cap so a single bad page can never hang the whole crawl. */
  // Extra `runs` (issue #179) each cost a full lightweight navigation on top
  // of the base budget — 8s/run is generous headroom for the fast goto +
  // networkidle + vitals read in captureVitalsSample.
  const extraRunsBudgetMs = Math.max(0, (opts.runs ?? 1) - 1) * 8_000;
  const overallBudgetMs = (opts.fast ? 25_000 : 60_000) + extraRunsBudgetMs;
  const deadline = start + overallBudgetMs;
  const remaining = () => Math.max(500, deadline - Date.now());

  // Lock the budget at the outermost level. Every internal step already has
  // its own `Math.min(X, remaining())` timeout, but in practice some
  // Playwright operations can outlive their declared timeout — most commonly
  // `page.evaluate(...)` when the page JS engine is busy running a previously-
  // dispatched evaluate (e.g. scrollFullPage's queued setTimeout chain),
  // `page.waitForLoadState("networkidle")` against a page that never reaches
  // idle (many concurrent deferred fetches), and `page.content()` while the
  // DOM is being mutated by hydration. When any of those misbehave, the
  // function would silently exceed its budget — we've observed 490+ second
  // captures of CMS-heavy pages with 10+ deferred sections in flight.
  //
  // The outer `Promise.race` adds a final 10 second safety margin on top
  // of `overallBudgetMs`. If anything inside takes longer than that, the
  // race returns a partial PageCapture built from whatever the collectors
  // managed to gather, so the rest of the crawl can proceed.
  const buildPartial = (): PageCapture => ({
    url: opts.url,
    finalUrl,
    status: response?.status() ?? 0,
    viewport: opts.viewport,
    side: opts.side,
    durationMs: Date.now() - start,
    html,
    vitals: vitals ?? { lcp: null, cls: null, fcp: null, ttfb: null, inp: null },
    vitalsStats,
    vitalsFullPage: vitalsFullPage ?? undefined,
    console: state.console,
    network: state.network,
    screenshotPath: opts.screenshotPath,
    harPath: opts.harPath,
    tracePath: opts.tracePath,
    xRobotsTag,
    pairKey: opts.pairKey,
  });

  let response: Response | null = null;
  let finalUrl = opts.url;
  let xRobotsTag: string | null = null;
  let vitals: WebVitals | null = null;
  let vitalsStats: WebVitalsStats | undefined;
  let vitalsFullPage: WebVitals | null = null;
  let html = "";

  /**
   * Read `window.__parity_vitals` off the page. Wrapped in its own race so
   * a wedged `page.evaluate` (previous evaluate still queued — see the
   * scrollFullPage `__name` comment above) can't block past its budget.
   */
  const readVitals = async (): Promise<WebVitals | null> => {
    dlog(
      opts.side,
      opts.viewport,
      `    capturePage: vitals evaluate (cap=${Math.min(5_000, remaining())}ms)`,
    );
    return (
      (await Promise.race([
        page
          .evaluate(() => (window as unknown as { __parity_vitals?: WebVitals }).__parity_vitals)
          .catch(() => null),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), Math.min(5_000, remaining())),
        ),
      ])) ?? null
    );
  };

  // Resolve immediately when the browser process dies or the page crashes so
  // the outer race returns a partial capture instead of hanging until the
  // 10s-safety-margin timeout (or indefinitely when the event loop stalls).
  let _resolveDisconnect!: () => void;
  const disconnectPromise = new Promise<void>((r) => {
    _resolveDisconnect = r;
  });
  const browser = page.context().browser();
  const handleBrowserDisconnect = (): void => {
    dlog(opts.side, opts.viewport, "    capturePage: browser disconnected — aborting capture");
    _resolveDisconnect();
  };
  const handlePageCrash = (): void => {
    dlog(opts.side, opts.viewport, "    capturePage: page crashed — aborting capture");
    _resolveDisconnect();
  };
  browser?.on("disconnected", handleBrowserDisconnect);
  page.on("crash", handlePageCrash);

  const inner = async (): Promise<PageCapture> => {
    try {
      dlog(opts.side, opts.viewport, `    capturePage: goto(${opts.url}) start`);
      response = await page.goto(opts.url, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(opts.timeoutMs ?? 30_000, remaining()),
      });
      dlog(
        opts.side,
        opts.viewport,
        `    capturePage: goto done status=${response?.status() ?? "?"} (remaining=${remaining()}ms)`,
      );
      finalUrl = page.url();
      if (response) {
        const headers = response.headers();
        xRobotsTag = headers["x-robots-tag"] ?? null;
      }
      if (opts.fast) {
        // Fast path: just settle a bit after DOM is ready, no full load wait, no scroll.
        // Issue #55: skip networkidle entirely for dev servers (HMR/SSE keep the
        // network busy forever).
        if (!opts.noNetworkIdle) {
          await page
            .waitForLoadState("networkidle", { timeout: Math.min(4_000, remaining()) })
            .catch(() => undefined);
        }
        await page.waitForTimeout(Math.min(opts.settleMs ?? 1_200, remaining()));
        // Fast path never scrolls, so this is the only read — same scope
        // as the non-fast path's pre-scroll read.
        vitals = await readVitals();
      } else {
        dlog(
          opts.side,
          opts.viewport,
          `    capturePage: waitForLoadState('load') (cap=${Math.min(12_000, remaining())}ms)`,
        );
        await page
          .waitForLoadState("load", { timeout: Math.min(12_000, remaining()) })
          .catch(() => undefined);
        if (!opts.noNetworkIdle) {
          dlog(
            opts.side,
            opts.viewport,
            `    capturePage: waitForLoadState('networkidle') (cap=${Math.min(6_000, remaining())}ms)`,
          );
          await page
            .waitForLoadState("networkidle", { timeout: Math.min(6_000, remaining()) })
            .catch(() => undefined);
        }
        dlog(
          opts.side,
          opts.viewport,
          `    capturePage: settle (cap=${Math.min(opts.settleMs ?? 2_000, remaining())}ms)`,
        );
        await page.waitForTimeout(Math.min(opts.settleMs ?? 2_000, remaining()));

        // Read LCP/CLS BEFORE the forced full-page autoscroll. Reading
        // after scrollFullPage() (the old behavior) let below-the-fold
        // lazy content the crawler itself dragged into view outscore the
        // real above-the-fold LCP candidate and count its layout shifts
        // toward CLS — neither of which a real first-paint or Lighthouse's
        // fixed-viewport, non-scrolling trace would ever see. Issue #185.
        vitals = await readVitals();

        // Auto-scroll to trigger lazy-loaded content (images, sections, analytics)
        if (opts.scrollToLoad !== false && remaining() > 3_000) {
          // Budget for the scroll itself: 45s OR remaining, whichever is
          // smaller. The new adaptive `scrollFullPage` stops as soon as the
          // page height stabilizes, so on fast pages it exits in 5-10s.
          // We pass the budget INTO the page.evaluate so the inner loop is
          // self-bounded, and ALSO race it externally as a hard safety cap.
          const scrollBudget = Math.min(45_000, remaining());
          dlog(
            opts.side,
            opts.viewport,
            `    capturePage: scrollFullPage start (budget=${scrollBudget}ms, remaining=${remaining()}ms)`,
          );
          const scrollResult = await Promise.race([
            scrollFullPage(page, scrollBudget).catch((err) => {
              // Don't swallow — a syntax/reference error inside the browser-
              // side evaluate would otherwise look indistinguishable from a
              // legitimate timeout, and that exact bug bit us once already.
              dlog(
                opts.side,
                opts.viewport,
                `    capturePage: scrollFullPage threw: ${(err as Error).message}`,
              );
              return undefined;
            }),
            new Promise<undefined>((resolve) =>
              setTimeout(() => resolve(undefined), scrollBudget + 2_000),
            ),
          ]);
          if (scrollResult) {
            dlog(
              opts.side,
              opts.viewport,
              `    capturePage: scrollFullPage done steps=${scrollResult.steps} finalHeight=${scrollResult.finalHeight} stable=${scrollResult.stableAtEnd} duration=${scrollResult.durationMs}ms (remaining=${remaining()}ms)`,
            );
          } else {
            dlog(
              opts.side,
              opts.viewport,
              `    capturePage: scrollFullPage timed out at outer race (remaining=${remaining()}ms)`,
            );
          }
          // Post-scroll settle. With the new adaptive scroll already doing
          // inter-step skeleton waits, this is just a small grace period
          // for late analytics pings and trailing image decodes.
          if (!opts.noNetworkIdle && remaining() > 2_000) {
            dlog(
              opts.side,
              opts.viewport,
              `    capturePage: post-scroll networkidle (cap=${Math.min(3_000, remaining())}ms)`,
            );
            await page
              .waitForLoadState("networkidle", { timeout: Math.min(3_000, remaining()) })
              .catch(() => undefined);
          }
          await page.waitForTimeout(Math.min(800, remaining()));

          // Second, distinct read: full-page LCP/CLS including whatever
          // the forced scroll dragged into view. Useful as "field-like"
          // CLS (real users do scroll), but kept out of `vitals` so it's
          // never silently diffed 1:1 against Lighthouse. Issue #185.
          vitalsFullPage = await readVitals();
        }
      }
    } catch (err) {
      state.console.push({
        type: "error",
        text: `[navigation-error] ${(err as Error).message}`,
      });
    }

    // Fallback: if navigation threw before either branch above reached its
    // vitals read (e.g. goto() timed out but the page still rendered
    // something), try once more so a slow-but-alive page isn't reported as
    // all-null vitals.
    if (vitals === null) {
      vitals = await readVitals();
    }

    if (!opts.skipScreenshot) {
      // Pin every detected carousel to slide 0 BEFORE the screenshot so
      // prod and cand capture the same frame (issue #22). Race against a
      // 3s cap — if the page's JS queue is wedged, we'd rather take a
      // possibly-mis-framed shot than burn the capture budget here.
      // (cubic review feedback on #32: previous unbounded await could hang.)
      await Promise.race([
        stabilizeCarousels(page).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(3_000, remaining()))),
      ]);
      // Final safety net: wait for any lingering skeleton placeholders to
      // resolve before the screenshot fires. Budget reduced from 10s to 5s
      // since the adaptive scrollFullPage already does inter-step skeleton
      // waits — by the time we reach this point most pages have already
      // settled. We keep it as a last-resort for sites with skeletons that
      // never enter the viewport (off-screen lazy renders).
      const skeletonBudget = Math.min(5_000, remaining());
      if (skeletonBudget > 500) {
        dlog(
          opts.side,
          opts.viewport,
          `    capturePage: waitForSkeletons (cap=${skeletonBudget}ms)`,
        );
        await Promise.race([
          waitForSkeletonsToResolve(page, skeletonBudget).catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, skeletonBudget)),
        ]);
      }
      // Log the final skeleton count right before the screenshot so we can
      // diagnose "page wasn't ready" issues without having to re-run.
      try {
        const skeletonsAtCapture = await page
          .evaluate((sel) => document.querySelectorAll(sel).length, SKELETON_SELECTOR)
          .catch(() => -1);
        dlog(
          opts.side,
          opts.viewport,
          `    capturePage: pre-screenshot skeletons=${skeletonsAtCapture}`,
        );
      } catch {
        /* tolerated */
      }
      dlog(
        opts.side,
        opts.viewport,
        `    capturePage: screenshot start (cap=${Math.min(15_000, remaining())}ms)`,
      );
      await Promise.race([
        page
          .screenshot({ path: opts.screenshotPath, fullPage: true, animations: "disabled" })
          .catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(15_000, remaining()))),
      ]);
      dlog(opts.side, opts.viewport, "    capturePage: screenshot done");
    }

    dlog(
      opts.side,
      opts.viewport,
      `    capturePage: page.content() (cap=${Math.min(5_000, remaining())}ms)`,
    );
    html = await Promise.race([
      page.content().catch(() => ""),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), Math.min(5_000, remaining()))),
    ]);

    dlog(
      opts.side,
      opts.viewport,
      `    capturePage: flushCollectors (cap=${Math.min(3_000, remaining())}ms)`,
    );
    await flushCollectors(state, Math.min(3_000, remaining()));

    const extraRuns = Math.max(0, (opts.runs ?? 1) - 1);
    if (extraRuns > 0 && vitals) {
      dlog(opts.side, opts.viewport, `    capturePage: vitals repeat x${extraRuns} start`);
      const samples: WebVitals[] = [vitals];
      const ctx = page.context();
      for (let i = 0; i < extraRuns && remaining() > 4_000; i++) {
        const sample = await captureVitalsSample(ctx, opts.url, Math.min(10_000, remaining()));
        if (sample) samples.push(sample);
      }
      vitalsStats = aggregateVitalsSamples(samples);
      vitals = {
        lcp: vitalsStats.lcp?.median ?? vitals.lcp,
        cls: vitalsStats.cls?.median ?? vitals.cls,
        fcp: vitalsStats.fcp?.median ?? vitals.fcp,
        ttfb: vitalsStats.ttfb?.median ?? vitals.ttfb,
        inp: vitalsStats.inp?.median ?? vitals.inp,
      };
      dlog(
        opts.side,
        opts.viewport,
        `    capturePage: vitals repeat done samples=${samples.length}/${opts.runs}`,
      );
    }

    dlog(opts.side, opts.viewport, `    capturePage: inner done total=${Date.now() - start}ms`);
    return buildPartial();
  };

  // Outer hard deadline = budget + 10s safety. If anything still hangs past
  // its declared internal timeout, fall back to a partial capture rather
  // than blocking the whole crawl.
  //
  // disconnectPromise is an additional leg: if the browser process dies
  // mid-capture (crash / OOM kill), the race resolves immediately instead of
  // waiting for the safety-margin timeout or — worse — hanging indefinitely
  // when a wedged CDP socket prevents the event loop from advancing.
  const SAFETY_MARGIN_MS = 10_000;
  const outerDeadlineMs = overallBudgetMs + SAFETY_MARGIN_MS;
  const result = await Promise.race([
    inner(),
    new Promise<PageCapture>((resolve) =>
      setTimeout(() => {
        state.console.push({
          type: "error",
          text: `[capture-timeout] capturePage exceeded ${outerDeadlineMs}ms outer deadline — returning partial capture`,
        });
        resolve(buildPartial());
      }, outerDeadlineMs),
    ),
    disconnectPromise.then((): PageCapture => {
      state.console.push({
        type: "error",
        text: "[browser-disconnected] browser/page crashed — returning partial capture",
      });
      return buildPartial();
    }),
  ]);
  browser?.off("disconnected", handleBrowserDisconnect);
  page.off("crash", handlePageCrash);
  return result;
}
