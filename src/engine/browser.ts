import type { Browser, BrowserContext, BrowserContextOptions } from "playwright";
import { chromium, devices } from "playwright";
import type { Viewport } from "../types/schema.ts";
import { CAROUSEL_STABILIZER_INIT_SCRIPT } from "./carousel-stabilizer.ts";

/**
 * Disable CSS animations + transitions to eliminate flake from in-flight motion
 * during screenshots and DOM snapshots.
 */
const DISABLE_ANIMATIONS_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
  }
`;

/**
 * Per-viewport User-Agent strings. Exposed for callers that issue raw
 * `fetch()` requests (preflight, sitemap warmup, html prefetch) so that
 * those calls match the UA the browser will send for the same viewport.
 *
 * Why this matters: workers and CDNs frequently key their edge cache by
 * device-class derived from UA (e.g. miess-tanstack does
 * `detectDevice(ua)` inside `buildSegment`). If a pre-flight fetch with a
 * desktop UA hits the worker before the mobile browser run, the desktop
 * cache segment gets populated, the mobile segment may remain cold, and
 * the mobile run reads a desktop variant.
 *
 * Use `userAgentFor(viewport)` from any non-Playwright call site.
 */
export const USER_AGENT_BY_VIEWPORT: Record<Viewport, string> = {
  mobile:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  tablet:
    "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  desktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

export function userAgentFor(viewport: Viewport): string {
  return USER_AGENT_BY_VIEWPORT[viewport];
}

/**
 * Mobile preset is built on top of `devices["Pixel 7"]` but we also pin
 * `userAgent`, `isMobile`, and `hasTouch` explicitly. Pinning shields
 * parity from silent regressions when Playwright bumps its device
 * catalog (or drops `Pixel 7` entirely on older versions) and guarantees
 * device-segmented edge caches see a real mobile UA.
 */
const VIEWPORT_PRESETS: Record<Viewport, BrowserContextOptions> = {
  mobile: {
    ...devices["Pixel 7"],
    userAgent: USER_AGENT_BY_VIEWPORT.mobile,
    isMobile: true,
    hasTouch: true,
  },
  tablet: {
    ...devices["iPad Mini"],
    userAgent: USER_AGENT_BY_VIEWPORT.tablet,
    isMobile: true,
    hasTouch: true,
  },
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: USER_AGENT_BY_VIEWPORT.desktop,
    isMobile: false,
    hasTouch: false,
  },
};

export interface LaunchOptions {
  headless?: boolean;
  slowMo?: number;
}

export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  return await chromium.launch({
    headless: opts.headless ?? true,
    slowMo: opts.slowMo ?? 0,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

export interface ContextOptions {
  viewport: Viewport;
  harPath?: string;
  tracesDir?: string;
  /** Force cohort/A-B cookies to a stable bucket */
  cohortCookieValue?: string;
}

export async function newContext(browser: Browser, opts: ContextOptions): Promise<BrowserContext> {
  const baseContext = VIEWPORT_PRESETS[opts.viewport];
  const ctx = await browser.newContext({
    ...baseContext,
    recordHar: opts.harPath ? { path: opts.harPath, mode: "minimal" } : undefined,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });

  // Disable animations on every page in this context
  await ctx.addInitScript({
    content: `
      try {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(DISABLE_ANIMATIONS_CSS)};
        (document.head || document.documentElement).appendChild(style);
      } catch (e) {}
    `,
  });

  // Install the carousel-stabilizer hook (issue #22). Runs before any user
  // JS so `window.__parityStabilizeCarousels()` is callable from
  // `stabilizeCarousels(page)` right before any screenshot.
  await ctx.addInitScript({ content: CAROUSEL_STABILIZER_INIT_SCRIPT });

  // Stable cohort cookie if requested
  if (opts.cohortCookieValue) {
    await ctx.addCookies([
      {
        name: "_abtest",
        value: opts.cohortCookieValue,
        url: "https://localhost",
      },
    ]);
  }

  if (opts.tracesDir) {
    await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  }

  return ctx;
}

export async function stopTracing(ctx: BrowserContext, path: string): Promise<void> {
  await ctx.tracing.stop({ path });
}
