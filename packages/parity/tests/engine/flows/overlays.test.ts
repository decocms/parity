import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  type FlowContext,
  dismissBlockingOverlay,
  dismissOverlays,
  overlaySelectorsFor,
} from "../../../src/engine/flows/shared.ts";
import { ParityRc } from "../../../src/types/schema.ts";

const CTX = { rc: {}, viewport: "mobile", side: "cand" } as unknown as FlowContext;

/**
 * A `Locator` whose `.evaluate` answers the two structural helpers from their
 * own queues: interception probes (`blockerAtTarget`) drain `blockers`, and
 * the icon-close geometry probe (`findOverlayCloseControl`, identified by its
 * `querySelectorAll` body) drains `closeControls`. Each returns `null` once
 * its queue is exhausted.
 */
function fakeTarget(
  blockers: Array<Record<string, unknown> | null>,
  closeControls: Array<{ x: number; y: number } | null> = [],
  neutralizeResults: boolean[] = [],
): Locator {
  let bi = 0;
  let ci = 0;
  let ni = 0;
  return {
    evaluate: (fn: unknown) => {
      const src = String(fn);
      // `neutralizeBlockerAtTarget` — identified by its `setProperty` body.
      if (src.includes("setProperty")) {
        return Promise.resolve(ni < neutralizeResults.length ? neutralizeResults[ni++] : false);
      }
      // `findOverlayCloseControl` — identified by its `querySelectorAll` body.
      if (src.includes("querySelectorAll")) {
        return Promise.resolve(ci < closeControls.length ? closeControls[ci++] : null);
      }
      // `blockerAtTarget` — the structural interception probe.
      return Promise.resolve(bi < blockers.length ? blockers[bi++] : null);
    },
  } as unknown as Locator;
}

function fakePage(opts: { closerVisible?: boolean } = {}) {
  const calls = { escape: 0, closerClick: 0, backdrop: 0 };
  const page = {
    keyboard: {
      press: (k: string) => {
        if (k === "Escape") calls.escape++;
        return Promise.resolve();
      },
    },
    waitForTimeout: () => Promise.resolve(),
    locator: () => ({
      first: () => ({
        isVisible: () => Promise.resolve(opts.closerVisible === true),
        click: () => {
          calls.closerClick++;
          return Promise.resolve();
        },
      }),
    }),
    mouse: {
      click: () => {
        calls.backdrop++;
        return Promise.resolve();
      },
    },
  } as unknown as Page;
  return { page, calls };
}

const BLOCKER = { tag: "div", id: "NewsletterPopup", className: "modal open", fullViewport: false };

describe("overlaySelectorsFor (#145)", () => {
  it("returns the built-in defaults when no rc override", () => {
    const list = overlaySelectorsFor({} as ParityRc);
    expect(list).toContain("[role='alertdialog']:visible");
    expect(list).toContain("[class*='newsletter' i]:visible");
    expect(list.length).toBeGreaterThan(5);
  });

  it("merges user overlaySelectors after the defaults, without replacing them", () => {
    const list = overlaySelectorsFor({ overlaySelectors: ["#NewsletterPopup"] } as ParityRc);
    expect(list).toContain("[role='alertdialog']:visible"); // default kept
    expect(list).toContain("#NewsletterPopup"); // user added
  });

  it("dedupes when a user selector duplicates a default", () => {
    const dup = "[class*='newsletter' i]:visible";
    const list = overlaySelectorsFor({ overlaySelectors: [dup] } as ParityRc);
    expect(list.filter((s) => s === dup)).toHaveLength(1);
  });

  it("ParityRc parses overlaySelectors and leaves it optional", () => {
    expect(ParityRc.parse({ overlaySelectors: ["#x"] }).overlaySelectors).toEqual(["#x"]);
    expect(ParityRc.parse({}).overlaySelectors).toBeUndefined();
  });
});

describe("dismissBlockingOverlay — structural detection (#146)", () => {
  it("returns null when nothing intercepts the target click point", async () => {
    const { page, calls } = fakePage();
    const result = await dismissBlockingOverlay(page, CTX, fakeTarget([null]));
    expect(result).toBeNull();
    expect(calls.escape).toBe(0);
  });

  it("dismisses via Escape when that clears the interception", async () => {
    const { page, calls } = fakePage();
    const result = await dismissBlockingOverlay(page, CTX, fakeTarget([BLOCKER, null]));
    expect(result).toMatchObject({
      reason: "click-point-intercepted",
      tag: "div",
      id: "NewsletterPopup",
      method: "escape",
      dismissed: true,
    });
    expect(calls.escape).toBe(1);
    expect(calls.closerClick).toBe(0);
  });

  it("falls back to a close button when Escape doesn't clear it", async () => {
    const { page, calls } = fakePage({ closerVisible: true });
    const result = await dismissBlockingOverlay(page, CTX, fakeTarget([BLOCKER, BLOCKER, null]));
    expect(result).toMatchObject({ method: "close-button", dismissed: true });
    expect(calls.escape).toBe(1);
    expect(calls.closerClick).toBe(1);
  });

  it("dismisses via an unnamed icon close control found by geometry (montecarlo case)", async () => {
    // No named close button; the overlay's close is a bare <button><svg/></button>
    // that only structural geometry can locate.
    const { page } = fakePage({ closerVisible: false });
    const result = await dismissBlockingOverlay(
      page,
      CTX,
      fakeTarget([BLOCKER, BLOCKER, null], [{ x: 12, y: 12 }]),
    );
    expect(result).toMatchObject({ method: "close-button", dismissed: true });
  });

  it("falls back to a backdrop click for a non-full-viewport overlay", async () => {
    const { page, calls } = fakePage({ closerVisible: false });
    const result = await dismissBlockingOverlay(page, CTX, fakeTarget([BLOCKER, BLOCKER, null]));
    expect(result).toMatchObject({ method: "backdrop-click", dismissed: true });
    expect(calls.backdrop).toBe(1);
  });

  it("still attempts a corner backdrop click on a full-viewport overlay (DaisyUI drawer case)", async () => {
    // A full-viewport overlay is often a click-to-dismiss backdrop; a corner
    // click can still close it, so we no longer skip the backdrop step.
    const full = { ...BLOCKER, fullViewport: true };
    const { page, calls } = fakePage({ closerVisible: false });
    const result = await dismissBlockingOverlay(page, CTX, fakeTarget([full, full, null]));
    expect(result).toMatchObject({ method: "backdrop-click", dismissed: true });
    expect(calls.backdrop).toBe(1);
  });

  it("neutralizes (hides) the interceptor as a last resort when polite methods fail", async () => {
    // Escape/close/backdrop all fail; the guarded hide clears interception.
    const { page } = fakePage({ closerVisible: false });
    const result = await dismissBlockingOverlay(
      page,
      CTX,
      fakeTarget([BLOCKER, BLOCKER, BLOCKER, null], [null], [true]),
    );
    expect(result).toMatchObject({ method: "neutralized", dismissed: true });
  });

  it("reports 'detected but not dismissed' when every strategy fails", async () => {
    const { page } = fakePage({ closerVisible: false });
    // blocker never clears across initial + all four re-checks.
    const result = await dismissBlockingOverlay(
      page,
      CTX,
      fakeTarget([BLOCKER, BLOCKER, BLOCKER, BLOCKER]),
    );
    expect(result).toMatchObject({ dismissed: false });
  });
});

describe("dismissOverlays performance (#151)", () => {
  it("completes in well under 2s when no overlays match (no-stall guarantee)", async () => {
    // With the old 400ms cap per selector, 12+ selectors × 400ms = ~5s in the
    // no-match case. The tightened cap (80ms) should complete in <960ms total
    // for the default 12-selector list, even with the fake-page overhead.
    // We use a generous budget (2s) to keep this robust in slow CI.
    const page = {
      locator: () => ({
        first: () => ({
          isVisible: () => new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5)),
          count: () => Promise.resolve(0), // fast no-match path
        }),
        count: () => Promise.resolve(0),
      }),
      keyboard: { press: () => Promise.resolve() },
      waitForTimeout: () => Promise.resolve(),
      mouse: { click: () => Promise.resolve() },
    } as unknown as Page;
    const start = Date.now();
    const result = await dismissOverlays(page, CTX);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result).toHaveLength(0);
  }, 5_000);
});
