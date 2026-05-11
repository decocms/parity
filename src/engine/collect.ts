import type { BrowserContext, Page, Response } from "playwright";
import type {
  ConsoleEntry,
  NetworkEntry,
  PageCapture,
  Side,
  Viewport,
  WebVitals,
} from "../types/schema.ts";

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
    state.console.push({
      type: "error",
      text: `[request-failed] ${req.url()} — ${req.failure()?.errorText ?? "unknown"}`,
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

export async function flushCollectors(state: CollectorState): Promise<void> {
  const flush = (state as CollectorState & { __flush?: () => Promise<void> }).__flush;
  if (flush) await flush();
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
    const buf = await resp.body();
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
async function scrollFullPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const step = Math.max(window.innerHeight * 0.8, 600);
      let y = 0;
      const max = document.documentElement.scrollHeight;
      const tick = () => {
        window.scrollTo(0, y);
        y += step;
        if (y < max) {
          setTimeout(tick, 220);
        } else {
          // Final scroll to bottom to make sure footer-side lazy loads
          window.scrollTo(0, max);
          setTimeout(() => {
            window.scrollTo(0, 0);
            resolve();
          }, 400);
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
}

export async function capturePage(page: Page, opts: CaptureOptions): Promise<PageCapture> {
  const start = Date.now();
  const state = attachCollectors(page);

  let response: Response | null = null;
  let finalUrl = opts.url;
  let xRobotsTag: string | null = null;
  try {
    response = await page.goto(opts.url, {
      waitUntil: "domcontentloaded",
      timeout: opts.timeoutMs ?? 30_000,
    });
    finalUrl = page.url();
    if (response) {
      const headers = response.headers();
      xRobotsTag = headers["x-robots-tag"] ?? null;
    }
    // Wait for full load (images, fonts, etc.) — capped
    await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
    // Then networkidle (background fetches settle)
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(opts.settleMs ?? 2_500);

    // Auto-scroll to trigger lazy-loaded content (images, sections, analytics)
    if (opts.scrollToLoad !== false) {
      await scrollFullPage(page).catch(() => undefined);
      // Brief settle after scrolling back to top
      await page.waitForTimeout(800);
    }
  } catch (err) {
    state.console.push({
      type: "error",
      text: `[navigation-error] ${(err as Error).message}`,
    });
  }

  const vitals = await page
    .evaluate(() => (window as unknown as { __parity_vitals?: WebVitals }).__parity_vitals)
    .catch(() => null);

  await page
    .screenshot({ path: opts.screenshotPath, fullPage: true, animations: "disabled" })
    .catch(() => {
      /* tolerated; screenshot path may be undefined if URL failed completely */
    });

  const html = await page.content().catch(() => "");

  await flushCollectors(state);

  return {
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
  };
}
