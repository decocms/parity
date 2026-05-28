import { describe, expect, it, vi } from "vitest";
import {
  CAROUSEL_STABILIZER_INIT_SCRIPT,
  stabilizeCarousels,
} from "../../src/engine/carousel-stabilizer.ts";

// We can't run the real init script outside a browser, but we CAN evaluate
// it inside Node's vm by mocking the window/document just enough to confirm
// it sets up the global without crashing. The actual carousel API hits are
// covered by the integration smoke against miess in the PR description.

function makeMockPage(evalResult: unknown): {
  evaluate: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
} {
  return {
    evaluate: vi.fn().mockResolvedValue(evalResult),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
}

describe("stabilizeCarousels", () => {
  it("returns all-zero when the in-page hook is missing (script not injected yet)", async () => {
    const page = makeMockPage(null);
    const r = await stabilizeCarousels(page as never);
    expect(r).toEqual({
      swiper: 0,
      splide: 0,
      slick: 0,
      keenSlider: 0,
      generic: 0,
      total: 0,
    });
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it("sums per-library counts and waits 150ms for repaint when total > 0", async () => {
    const page = makeMockPage({ swiper: 2, splide: 1, slick: 0, keenSlider: 0, generic: 3 });
    const r = await stabilizeCarousels(page as never);
    expect(r).toEqual({
      swiper: 2,
      splide: 1,
      slick: 0,
      keenSlider: 0,
      generic: 3,
      total: 6,
    });
    expect(page.waitForTimeout).toHaveBeenCalledWith(150);
  });

  it("skips the repaint wait when total is 0", async () => {
    const page = makeMockPage({ swiper: 0, splide: 0, slick: 0, keenSlider: 0, generic: 0 });
    const r = await stabilizeCarousels(page as never);
    expect(r.total).toBe(0);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  it("swallows evaluate errors and returns the empty result (never blocks screenshot)", async () => {
    const page = {
      evaluate: vi.fn().mockRejectedValue(new Error("page closed")),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };
    const r = await stabilizeCarousels(page as never);
    expect(r.total).toBe(0);
  });

  it("tolerates partial counts (missing keys treated as zero)", async () => {
    const page = makeMockPage({ swiper: 1 });
    const r = await stabilizeCarousels(page as never);
    expect(r).toEqual({
      swiper: 1,
      splide: 0,
      slick: 0,
      keenSlider: 0,
      generic: 0,
      total: 1,
    });
  });
});

describe("CAROUSEL_STABILIZER_INIT_SCRIPT", () => {
  it("declares the install guard and global hook", () => {
    expect(CAROUSEL_STABILIZER_INIT_SCRIPT).toMatch(/window\.__parityCarouselInstalled/);
    expect(CAROUSEL_STABILIZER_INIT_SCRIPT).toMatch(/window\.__parityStabilizeCarousels/);
    expect(CAROUSEL_STABILIZER_INIT_SCRIPT).toMatch(/window\.__parityCarouselStop/);
  });

  it("targets the four supported carousel libraries by selector", () => {
    expect(CAROUSEL_STABILIZER_INIT_SCRIPT).toMatch(/\.swiper/);
    expect(CAROUSEL_STABILIZER_INIT_SCRIPT).toMatch(/\.splide/);
    expect(CAROUSEL_STABILIZER_INIT_SCRIPT).toMatch(/\.slick/);
    expect(CAROUSEL_STABILIZER_INIT_SCRIPT).toMatch(/\.keen-slider/);
  });

  it("has a generic [data-section] fallback that scrolls horizontal scrollers to 0", () => {
    expect(CAROUSEL_STABILIZER_INIT_SCRIPT).toMatch(/data-section/);
    expect(CAROUSEL_STABILIZER_INIT_SCRIPT).toMatch(/carousel\|slider\|banner\|hero/);
    expect(CAROUSEL_STABILIZER_INIT_SCRIPT).toMatch(/scrollLeft\s*=\s*0/);
  });

  it("evaluates as syntactically valid JS in an isolated context", () => {
    // Provide minimal browser globals so the IIFE doesn't throw on parse.
    const fakeWindow: Record<string, unknown> = {};
    const fakeDocument = {
      querySelectorAll: () => [] as unknown[],
    };
    const fn = new Function(
      "window",
      "document",
      "jQuery",
      CAROUSEL_STABILIZER_INIT_SCRIPT,
    );
    expect(() => fn(fakeWindow, fakeDocument, undefined)).not.toThrow();
    // After running, the global hook should be defined.
    expect(typeof fakeWindow.__parityStabilizeCarousels).toBe("function");
    expect(fakeWindow.__parityCarouselInstalled).toBe(true);
  });

  it("the in-page hook is idempotent (second eval is a no-op)", () => {
    const fakeWindow: Record<string, unknown> = {};
    const fakeDocument = { querySelectorAll: () => [] as unknown[] };
    const fn = new Function(
      "window",
      "document",
      "jQuery",
      CAROUSEL_STABILIZER_INIT_SCRIPT,
    );
    fn(fakeWindow, fakeDocument, undefined);
    const firstHook = fakeWindow.__parityStabilizeCarousels;
    fn(fakeWindow, fakeDocument, undefined);
    // Second eval bails on the install guard — the hook reference should be
    // the SAME function instance, not a fresh one.
    expect(fakeWindow.__parityStabilizeCarousels).toBe(firstHook);
  });
});
