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

const VIEWPORT_PRESETS: Record<Viewport, BrowserContextOptions> = {
  mobile: {
    ...devices["Pixel 7"],
  },
  tablet: {
    ...devices["iPad Mini"],
  },
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
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
