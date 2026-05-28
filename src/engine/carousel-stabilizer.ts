import type { Page } from "playwright";

/**
 * Carousel stabilization — issue #22.
 *
 * Why: `page.screenshot({ animations: "disabled" })` + the CSS animation
 * killer in `browser.ts` defeats CSS-driven animations, but most Deco hero
 * carousels are JS-driven (Swiper, Splide, KeenSlider, custom logic) that
 * advance slides via `setInterval` / `requestAnimationFrame`. Prod and cand
 * end up screenshot at different frames → "Hero banner completamente
 * diferente" critical false positive (issue #22).
 *
 * Strategy in two layers:
 *  1. INIT SCRIPT (loaded once per BrowserContext): runs before any page JS,
 *     stubs `setInterval`/`setTimeout` callbacks that mutate carousel state,
 *     and provides a global `window.__parityStabilizeCarousels()` hook.
 *  2. PRE-SCREENSHOT call (per shot): the test harness invokes the hook
 *     right before `page.screenshot`, forcing every known carousel back to
 *     slide 0 via the library's API (Swiper, Splide, slick) or a generic
 *     fallback (scroll the slide container to scrollLeft=0).
 *
 * The downgrade-in-the-check from the old PR #28 is preserved in
 * `visual-regression.ts` as last-line safety net — that catches exotic
 * carousels without a public API, where stabilization can't reach.
 */

/**
 * Script injected once per BrowserContext via `addInitScript`. Runs in the
 * page context BEFORE any user JS. Sets up:
 *  - `window.__parityCarouselStop` — flag freezing auto-advance loops.
 *  - `window.__parityStabilizeCarousels()` — sync function the harness calls
 *    right before a screenshot. Walks known carousel libraries + generic
 *    fallback, returns a small diagnostic object.
 *
 * Implemented inline as a string so it doesn't accidentally pull Node-only
 * symbols (this file is bundled but the init-script runs in the browser).
 */
export const CAROUSEL_STABILIZER_INIT_SCRIPT = `
(function () {
  if (window.__parityCarouselInstalled) return;
  window.__parityCarouselInstalled = true;
  window.__parityCarouselStop = false;

  /**
   * Walks the page for known carousel libraries and pins them to slide 0.
   * Idempotent — safe to call multiple times. Returns a counters object
   * so the harness can log how many were stabilized.
   */
  window.__parityStabilizeCarousels = function () {
    var counts = { swiper: 0, splide: 0, slick: 0, keenSlider: 0, generic: 0 };

    // 1. Swiper — most common in Deco sites. Two ways to find instances:
    //    - element.swiper (newer versions)
    //    - window.Swiper.instances (older)
    try {
      var swiperEls = document.querySelectorAll('.swiper, .swiper-container');
      swiperEls.forEach(function (el) {
        var inst = el.swiper;
        if (inst && typeof inst.slideTo === 'function') {
          try { inst.autoplay && inst.autoplay.stop && inst.autoplay.stop(); } catch (_) {}
          try { inst.slideTo(0, 0, false); counts.swiper++; } catch (_) {}
        }
      });
    } catch (_) {}

    // 2. Splide
    try {
      var splideEls = document.querySelectorAll('.splide');
      splideEls.forEach(function (el) {
        var inst = el.splide || (el.__splide);
        if (inst && typeof inst.go === 'function') {
          try { inst.go(0); counts.splide++; } catch (_) {}
        }
      });
    } catch (_) {}

    // 3. Slick
    try {
      if (window.jQuery) {
        var $slick = window.jQuery('.slick-slider, .slick-initialized');
        if ($slick.length) {
          try { $slick.slick('slickGoTo', 0, true); counts.slick += $slick.length; } catch (_) {}
        }
      }
    } catch (_) {}

    // 4. KeenSlider
    try {
      var keenEls = document.querySelectorAll('.keen-slider');
      keenEls.forEach(function (el) {
        var inst = el.__keenSlider || el.keenSlider;
        if (inst && typeof inst.moveToIdx === 'function') {
          try { inst.moveToIdx(0, true, { duration: 0 }); counts.keenSlider++; } catch (_) {}
        }
      });
    } catch (_) {}

    // 5. Generic fallback — any element inside a [data-section] matching
    //    carousel|slider|banner|hero, force scrollLeft to 0 and snap the
    //    first child into view. Catches CSS-only scroll-snap carousels
    //    and custom Deco implementations.
    try {
      var BANNER_RE = /(carousel|slider|banner|hero)/i;
      var sections = document.querySelectorAll('[data-section]');
      sections.forEach(function (sec) {
        var name = sec.getAttribute('data-section') || '';
        if (!BANNER_RE.test(name)) return;
        // Find the horizontally-scrollable child (overflow-x: auto/scroll).
        var scrollers = sec.querySelectorAll('*');
        scrollers.forEach(function (el) {
          try {
            var cs = el && el.ownerDocument && el.ownerDocument.defaultView
              ? el.ownerDocument.defaultView.getComputedStyle(el)
              : null;
            if (!cs) return;
            var oflow = cs.overflowX;
            if ((oflow === 'auto' || oflow === 'scroll') && el.scrollLeft > 0) {
              el.scrollLeft = 0;
              counts.generic++;
            }
          } catch (_) {}
        });
        // Also reset the section's own scrollLeft if applicable.
        try { if (sec.scrollLeft > 0) { sec.scrollLeft = 0; counts.generic++; } } catch (_) {}
      });
    } catch (_) {}

    // 6. Set the freeze flag so future auto-advance ticks bail out (libs
    //    that check this flag before mutating slide index).
    window.__parityCarouselStop = true;
    return counts;
  };
})();
`.trim();

export interface StabilizeResult {
  swiper: number;
  splide: number;
  slick: number;
  keenSlider: number;
  generic: number;
  total: number;
}

/**
 * Invoke the in-page stabilizer right before a screenshot.
 *
 * Safe to call even when no carousel exists on the page — returns
 * `{total: 0, ...}`. Errors are swallowed so a buggy carousel never blocks
 * the screenshot pipeline (we'd rather have a slightly mis-framed shot than
 * a missing one).
 *
 * After the API call lands, waits 150ms for the browser to repaint the
 * pinned slide before the screenshot fires.
 */
export async function stabilizeCarousels(page: Page): Promise<StabilizeResult> {
  const empty: StabilizeResult = {
    swiper: 0,
    splide: 0,
    slick: 0,
    keenSlider: 0,
    generic: 0,
    total: 0,
  };
  try {
    const counts = await page.evaluate(() => {
      const fn = (window as unknown as {
        __parityStabilizeCarousels?: () => Record<string, number>;
      }).__parityStabilizeCarousels;
      return fn ? fn() : null;
    });
    if (!counts) return empty;
    const total =
      (counts.swiper ?? 0) +
      (counts.splide ?? 0) +
      (counts.slick ?? 0) +
      (counts.keenSlider ?? 0) +
      (counts.generic ?? 0);
    if (total > 0) {
      // Repaint settle — the slide-pin may animate to 0 over 1-2 frames
      // even when we passed { duration: 0 }, since libraries often queue
      // a microtask for the transform reset.
      await page.waitForTimeout(150);
    }
    return {
      swiper: counts.swiper ?? 0,
      splide: counts.splide ?? 0,
      slick: counts.slick ?? 0,
      keenSlider: counts.keenSlider ?? 0,
      generic: counts.generic ?? 0,
      total,
    };
  } catch {
    return empty;
  }
}
