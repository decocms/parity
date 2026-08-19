import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { capturePage } from "../../src/engine/collect.ts";
import type { WebVitals } from "../../src/types/schema.ts";

/**
 * Regression test for issue #185: `capturePage()` used to read
 * `window.__parity_vitals` only AFTER `scrollFullPage()` forced a
 * full-page autoscroll, so LCP/CLS were contaminated by lazy content the
 * crawler itself dragged into view — content a real first-paint (or
 * Lighthouse's non-scrolling trace) would never have loaded.
 *
 * This fake `page` never runs real browser JS (no jsdom/Chromium). It
 * intercepts every `page.evaluate(fn, arg)` call by argument *shape*:
 * a numeric second argument is `scrollFullPage`'s budget, so that call is
 * treated as "the forced scroll happened" and mutates a shared vitals
 * state to simulate a below-the-fold banner becoming the new LCP and a
 * shelf snapping into place (CLS). Any other `evaluate` call is treated as
 * a `window.__parity_vitals` read and returns a snapshot of the current
 * state. `skipScreenshot: true` keeps the surface small — it skips
 * carousel-stabilization and skeleton-polling `evaluate` calls entirely,
 * so only the two calls above ever happen.
 */
function makeFakeCapture(): { page: EventEmitter & Record<string, unknown> } {
  const browser = new EventEmitter() as EventEmitter & Record<string, unknown>;

  const vitalsState: WebVitals = { lcp: 1200, cls: 0.02, fcp: 900, ttfb: 100, inp: null };

  const page = new EventEmitter() as EventEmitter & Record<string, unknown>;
  page.goto = async () => ({ status: () => 200, headers: () => ({}) });
  page.url = () => "https://example.com/";
  page.waitForLoadState = async () => undefined;
  page.waitForTimeout = async () => undefined;
  page.content = async () => "<html></html>";
  page.context = () => ({ browser: () => browser });
  page.evaluate = async (_fn: unknown, arg?: unknown) => {
    if (typeof arg === "number") {
      // scrollFullPage's page.evaluate(asyncFn, budgetMs) call — simulate
      // a below-the-fold hero/shelf loading in and shifting layout as a
      // result of the forced scroll, exactly the scenario in issue #185.
      vitalsState.cls = (vitalsState.cls ?? 0) + 0.3;
      vitalsState.lcp = 4000;
      return { steps: 2, finalHeight: 4000, stableAtEnd: true };
    }
    // window.__parity_vitals read.
    return { ...vitalsState };
  };

  return { page };
}

describe("capturePage — vitals read timing vs. forced scroll (issue #185)", () => {
  it("captures pre-scroll vitals in `vitals`, unaffected by scroll-triggered CLS/LCP", async () => {
    const { page } = makeFakeCapture();

    // biome-ignore lint/suspicious/noExplicitAny: minimal Playwright Page stand-in
    const capture = await capturePage(page as any, {
      url: "https://example.com/",
      side: "prod",
      viewport: "mobile",
      screenshotPath: "/tmp/fake.png",
      skipScreenshot: true,
      settleMs: 0,
    });

    // Pre-scroll values — must NOT include the scroll-triggered shift.
    expect(capture.vitals.cls).toBeCloseTo(0.02, 5);
    expect(capture.vitals.lcp).toBe(1200);
  });

  it("captures the scroll-contaminated snapshot separately in `vitalsFullPage`", async () => {
    const { page } = makeFakeCapture();

    // biome-ignore lint/suspicious/noExplicitAny: minimal Playwright Page stand-in
    const capture = await capturePage(page as any, {
      url: "https://example.com/",
      side: "prod",
      viewport: "mobile",
      screenshotPath: "/tmp/fake.png",
      skipScreenshot: true,
      settleMs: 0,
    });

    expect(capture.vitalsFullPage).toBeDefined();
    expect(capture.vitalsFullPage?.cls).toBeCloseTo(0.32, 5);
    expect(capture.vitalsFullPage?.lcp).toBe(4000);
  });

  it("omits `vitalsFullPage` entirely when scrollToLoad is disabled (no second scope exists)", async () => {
    const { page } = makeFakeCapture();

    // biome-ignore lint/suspicious/noExplicitAny: minimal Playwright Page stand-in
    const capture = await capturePage(page as any, {
      url: "https://example.com/",
      side: "prod",
      viewport: "mobile",
      screenshotPath: "/tmp/fake.png",
      skipScreenshot: true,
      settleMs: 0,
      scrollToLoad: false,
    });

    expect(capture.vitalsFullPage).toBeUndefined();
    // Without a scroll pass, `vitals` is simply the only (unpolluted) read.
    expect(capture.vitals.cls).toBeCloseTo(0.02, 5);
    expect(capture.vitals.lcp).toBe(1200);
  });

  it("fast captures never scroll, so `vitals` is the single pre-scroll-equivalent read", async () => {
    const { page } = makeFakeCapture();

    // biome-ignore lint/suspicious/noExplicitAny: minimal Playwright Page stand-in
    const capture = await capturePage(page as any, {
      url: "https://example.com/",
      side: "prod",
      viewport: "mobile",
      screenshotPath: "/tmp/fake.png",
      skipScreenshot: true,
      settleMs: 0,
      fast: true,
    });

    expect(capture.vitalsFullPage).toBeUndefined();
    expect(capture.vitals.cls).toBeCloseTo(0.02, 5);
    expect(capture.vitals.lcp).toBe(1200);
  });
});
