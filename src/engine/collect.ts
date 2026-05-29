import type { BrowserContext, Page, Response } from "playwright";
import type {
  ConsoleEntry,
  NetworkEntry,
  PageCapture,
  Side,
  Viewport,
  WebVitals,
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

    // CLS (cumulative, excluding shifts after recent user input)
    try {
      let cls = 0;
      new PerformanceObserver(function(list) {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            cls += entry.value;
            window.__parity_vitals.cls = cls;
          }
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
  await Promise.race([
    flush(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function responseToEntry(resp: Response): Promise<NetworkEntry> {
  const req = resp.request();
  const headers = resp.headers();
  const timing = req.timing();
  const bytes = (await safeBodySize(resp)) ?? parseIntOrNull(headers["content-length"]);
  return {
    url: resp.url(),
    method: req.method(),
    status: resp.status(),
    resourceType: req.resourceType(),
    fromCache: resp.fromServiceWorker() || isFromHttpCache(resp),
    bytes,
    durationMs: timing.responseEnd > 0 ? timing.responseEnd - timing.requestStart : null,
    cacheControl: headers["cache-control"] ?? null,
    serverTiming: headers["server-timing"] ?? null,
    decoSection: headers["x-deco-section"] ?? null,
  };
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
async function waitForSkeletonsToResolve(page: Page, maxMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const count = await page
      .evaluate((sel) => document.querySelectorAll(sel).length, SKELETON_SELECTOR)
      .catch(() => 0);
    if (count === 0) return;
    await page.waitForTimeout(500).catch(() => undefined);
  }
}

async function scrollFullPage(page: Page): Promise<void> {
  // Scrolling exists to trigger IntersectionObserver-gated lazy sections
  // (VTEX intelligent search shelves, Shopify collection grids, deferred
  // hero banners). Three tuning calls that the obvious version got wrong:
  //
  //  - **Step pause (400ms, was 220ms).** 220ms is below the typical fetch
  //    latency from a VTEX shelf API hit (300-700ms). The viewport passed
  //    over the section before the products arrived, so the IO never saw
  //    "loaded" and downstream screenshots captured skeletons. 400ms lets
  //    each shelf get a fetch dispatched while the viewport sits on it.
  //
  //  - **Bottom dwell (1500ms, was 400ms).** Footer and "you might also
  //    like" carousels typically only fetch when the bottom of the page
  //    enters the viewport. A 400ms dwell isn't enough for the resulting
  //    requests to land and render — bumped to 1500.
  //
  //  - **Return-to-top settle (700ms).** Some lazy frameworks fire IO
  //    "leave" callbacks when we snap back to 0 and re-skeletonize the
  //    sections that just rendered. The extra dwell at top lets those
  //    re-renders complete (if they happen) before the screenshot fires.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const step = Math.max(window.innerHeight * 0.8, 600);
      let y = 0;
      const max = document.documentElement.scrollHeight;
      const tick = () => {
        window.scrollTo(0, y);
        y += step;
        if (y < max) {
          setTimeout(tick, 400);
        } else {
          window.scrollTo(0, max);
          setTimeout(() => {
            window.scrollTo(0, 0);
            setTimeout(resolve, 700);
          }, 1500);
        }
      };
      tick();
    });
  });
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
}

export async function capturePage(page: Page, opts: CaptureOptions): Promise<PageCapture> {
  const start = Date.now();
  const state = attachCollectors(page);
  /** Hard total cap so a single bad page can never hang the whole crawl. */
  const overallBudgetMs = opts.fast ? 25_000 : 60_000;
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
    console: state.console,
    network: state.network,
    screenshotPath: opts.screenshotPath,
    harPath: opts.harPath,
    tracePath: opts.tracePath,
    xRobotsTag,
  });

  let response: Response | null = null;
  let finalUrl = opts.url;
  let xRobotsTag: string | null = null;
  let vitals: WebVitals | null = null;
  let html = "";

  const inner = async (): Promise<PageCapture> => {
    try {
      dlog(opts.side, opts.viewport, `    capturePage: goto(${opts.url}) start`);
      response = await page.goto(opts.url, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(opts.timeoutMs ?? 30_000, remaining()),
      });
      dlog(opts.side, opts.viewport, `    capturePage: goto done status=${response?.status() ?? "?"} (remaining=${remaining()}ms)`);
      finalUrl = page.url();
      if (response) {
        const headers = response.headers();
        xRobotsTag = headers["x-robots-tag"] ?? null;
      }
      if (opts.fast) {
        // Fast path: just settle a bit after DOM is ready, no full load wait, no scroll
        await page
          .waitForLoadState("networkidle", { timeout: Math.min(4_000, remaining()) })
          .catch(() => undefined);
        await page.waitForTimeout(Math.min(opts.settleMs ?? 1_200, remaining()));
      } else {
        dlog(opts.side, opts.viewport, `    capturePage: waitForLoadState('load') (cap=${Math.min(12_000, remaining())}ms)`);
        await page.waitForLoadState("load", { timeout: Math.min(12_000, remaining()) }).catch(() => undefined);
        dlog(opts.side, opts.viewport, `    capturePage: waitForLoadState('networkidle') (cap=${Math.min(6_000, remaining())}ms)`);
        await page.waitForLoadState("networkidle", { timeout: Math.min(6_000, remaining()) }).catch(() => undefined);
        dlog(opts.side, opts.viewport, `    capturePage: settle (cap=${Math.min(opts.settleMs ?? 2_000, remaining())}ms)`);
        await page.waitForTimeout(Math.min(opts.settleMs ?? 2_000, remaining()));

        // Auto-scroll to trigger lazy-loaded content (images, sections, analytics)
        if (opts.scrollToLoad !== false && remaining() > 3_000) {
          dlog(opts.side, opts.viewport, `    capturePage: scrollFullPage start (remaining=${remaining()}ms)`);
          await Promise.race([
            scrollFullPage(page).catch(() => undefined),
            new Promise<void>((resolve) => setTimeout(resolve, Math.min(10_000, remaining()))),
          ]);
          dlog(opts.side, opts.viewport, `    capturePage: scrollFullPage done (remaining=${remaining()}ms)`);
          // Scrolling to the bottom kicks off a wave of lazy fetches (product
          // shelves, hero images, footer widgets). Before the screenshot
          // fires, give those a real chance to land — otherwise we capture
          // a forest of skeleton placeholders and the LLM downstream thinks
          // half the page is "missing-component". Bumped from a flat 600ms
          // to (networkidle race up to 3s) + 800ms after observing prod
          // screenshots of miess home rendering ~30% skeletons.
          if (remaining() > 2_000) {
            dlog(opts.side, opts.viewport, `    capturePage: post-scroll networkidle (cap=${Math.min(3_000, remaining())}ms)`);
            await page
              .waitForLoadState("networkidle", { timeout: Math.min(3_000, remaining()) })
              .catch(() => undefined);
          }
          await page.waitForTimeout(Math.min(800, remaining()));
        }
      }
    } catch (err) {
      state.console.push({
        type: "error",
        text: `[navigation-error] ${(err as Error).message}`,
      });
    }

    // `page.evaluate(...)` has no built-in timeout — if a previous evaluate
    // is still pending in the page's JS queue (e.g. scrollFullPage's
    // setTimeout chain that didn't resolve before its outer race fired),
    // this call blocks until that previous evaluate settles. Wrap it in
    // an explicit race so the budget is actually enforced.
    dlog(opts.side, opts.viewport, `    capturePage: vitals evaluate (cap=${Math.min(5_000, remaining())}ms)`);
    vitals = (await Promise.race([
      page
        .evaluate(() => (window as unknown as { __parity_vitals?: WebVitals }).__parity_vitals)
        .catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.min(5_000, remaining()))),
    ])) ?? null;

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
      // Wait for skeleton placeholders (shelf-cards, lazy sections, busy
      // panels) to resolve before the screenshot fires. Without this we'd
      // capture half the page as shimmer loaders, and the visual-diff LLM
      // would report phantom "missing-component" diffs because one side
      // happened to finish first. 6s cap is enough for VTEX intelligent
      // search to populate a shelf; pages without skeletons short-circuit
      // on the first poll.
      const skeletonBudget = Math.min(10_000, remaining());
      if (skeletonBudget > 500) {
        dlog(opts.side, opts.viewport, `    capturePage: waitForSkeletons (cap=${skeletonBudget}ms)`);
        await Promise.race([
          waitForSkeletonsToResolve(page, skeletonBudget).catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, skeletonBudget)),
        ]);
      }
      dlog(opts.side, opts.viewport, `    capturePage: screenshot start (cap=${Math.min(15_000, remaining())}ms)`);
      await Promise.race([
        page.screenshot({ path: opts.screenshotPath, fullPage: true, animations: "disabled" }).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, Math.min(15_000, remaining()))),
      ]);
      dlog(opts.side, opts.viewport, "    capturePage: screenshot done");
    }

    dlog(opts.side, opts.viewport, `    capturePage: page.content() (cap=${Math.min(5_000, remaining())}ms)`);
    html = await Promise.race([
      page.content().catch(() => ""),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), Math.min(5_000, remaining()))),
    ]);

    dlog(opts.side, opts.viewport, `    capturePage: flushCollectors (cap=${Math.min(3_000, remaining())}ms)`);
    await flushCollectors(state, Math.min(3_000, remaining()));

    dlog(opts.side, opts.viewport, `    capturePage: inner done total=${Date.now() - start}ms`);
    return buildPartial();
  };

  // Outer hard deadline = budget + 10s safety. If anything still hangs past
  // its declared internal timeout, fall back to a partial capture rather
  // than blocking the whole crawl.
  const SAFETY_MARGIN_MS = 10_000;
  const outerDeadlineMs = overallBudgetMs + SAFETY_MARGIN_MS;
  return Promise.race([
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
  ]);
}
