import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  isCartRevealed,
  isCartUiVisible,
  waitForCartReveal,
} from "../../../src/engine/flows/cart-helpers.ts";
import type { FlowContext } from "../../../src/engine/flows/shared.ts";
import { selectorsFor } from "../../../src/engine/selectors.ts";
import type { ParityRc } from "../../../src/types/schema.ts";

/**
 * Fake `Page` exposing just what the reveal-detection helpers touch:
 * `locator(sel).first().isVisible()`, `.count()`, `.first().innerText()`, and
 * `waitForTimeout()`. `visible` = selectors that report visible; `scopeText` =
 * innerText per selector (also makes `count()` return 1 for that selector).
 * `revealAfter` simulates an async drawer: the given selector reports hidden
 * for the first N `isVisible` polls, then flips to visible.
 */
function fakePage(
  opts: {
    visible?: string[];
    scopeText?: Record<string, string>;
    revealAfter?: { selector: string; polls: number };
  } = {},
): Page {
  const visible = new Set(opts.visible ?? []);
  const scopeText = opts.scopeText ?? {};
  const reveal = opts.revealAfter;
  let pollsSeen = 0;
  const isVisibleFor = (sel: string): boolean => {
    if (reveal && sel === reveal.selector) return pollsSeen >= reveal.polls;
    return visible.has(sel);
  };
  return {
    waitForTimeout: () => {
      pollsSeen++;
      return Promise.resolve();
    },
    locator: (sel: string) => ({
      first: () => ({
        isVisible: () => Promise.resolve(isVisibleFor(sel)),
        innerText: () => Promise.resolve(scopeText[sel] ?? ""),
      }),
      count: () => Promise.resolve(sel in scopeText || isVisibleFor(sel) ? 1 : 0),
    }),
  } as unknown as Page;
}

function ctxWith(rc: Partial<ParityRc> = {}): FlowContext {
  return { rc: { selectors: {}, ...rc } } as unknown as FlowContext;
}

describe("minicartPanel selector (#149)", () => {
  it("selectorsFor exposes data-attribute defaults, incl. [data-qa-minicart]", () => {
    const list = selectorsFor("minicartPanel", {});
    expect(list).toContain("[data-qa-minicart]");
    expect(list).toContain("[data-minicart]");
  });

  it(".parityrc.json override is tried first, before the defaults", () => {
    const list = selectorsFor("minicartPanel", {
      selectors: { minicartPanel: "#MyDrawer" },
    } as ParityRc);
    expect(list[0]).toBe("#MyDrawer");
    expect(list).toContain("[data-qa-minicart]"); // defaults still present
  });
});

describe("isCartUiVisible — reveal detection (#149)", () => {
  it("detects a data-qa/Tailwind drawer via the minicartPanel default (montecarlo case)", async () => {
    // Drawer root is `<div data-qa-minicart class="flex flex-col ...">` — no
    // role=dialog, no `data-minicart`, no cart-ish class. The hardcoded list
    // can't match it; the `[data-qa-minicart]` default can.
    const page = fakePage({ visible: ["[data-qa-minicart]"] });
    expect(await isCartUiVisible(page, ctxWith())).toBe("[data-qa-minicart]");
  });

  it("honors a .parityrc.json minicartPanel override", async () => {
    const page = fakePage({ visible: ["#MyDrawer"] });
    const ctx = ctxWith({ selectors: { minicartPanel: "#MyDrawer" } });
    expect(await isCartUiVisible(page, ctx)).toBe("#MyDrawer");
  });

  it("still matches the legacy hardcoded patterns (back-compat, no ctx)", async () => {
    const page = fakePage({ visible: ["[role='dialog']:visible"] });
    expect(await isCartUiVisible(page)).toBe("[role='dialog']:visible");
  });

  it("returns null when nothing cart-like is visible", async () => {
    expect(await isCartUiVisible(fakePage(), ctxWith())).toBeNull();
  });
});

describe("isCartRevealed — title scoped to the panel (#149)", () => {
  it("finds the product title inside a data-qa panel scope", async () => {
    const title = "Brinco Stud Summer Em Ouro Amarelo 18k";
    const page = fakePage({ scopeText: { "[data-qa-minicart]": `Minha Sacola ${title}` } });
    const result = await isCartRevealed(page, title, ctxWith());
    expect(result).toBe("title-found:[data-qa-minicart]");
  });
});

describe("waitForCartReveal — polling for a delayed reveal", () => {
  it("catches a drawer that becomes visible after several polls (montecarlo timing)", async () => {
    // The montecarlo drawer stays visibility:hidden for a while (CSS
    // allow-discrete transition + data-gated render) before revealing. A
    // one-shot snapshot would miss it; polling catches it.
    const page = fakePage({ revealAfter: { selector: "[data-qa-minicart]", polls: 3 } });
    // Sanity: an immediate snapshot sees nothing yet.
    expect(await isCartUiVisible(page, ctxWith())).toBeNull();
    const { marker, diagnostics } = await waitForCartReveal(page, null, ctxWith(), 5_000);
    expect(marker).toBe("[data-qa-minicart]");
    expect(diagnostics.timedOut).toBe(false);
    expect(diagnostics.pollCount).toBeGreaterThan(0);
  });

  it("returns null + probe diagnostics when the drawer never reveals within the budget", async () => {
    const page = fakePage();
    const { marker, diagnostics } = await waitForCartReveal(page, null, ctxWith(), 30);
    expect(marker).toBeNull();
    expect(diagnostics.timedOut).toBe(true);
    expect(diagnostics.budgetMs).toBe(30);
    expect(diagnostics.probes).toBeDefined();
  });

  it("probes distinguish present-but-hidden from not-in-dom", async () => {
    // [data-qa-minicart] is present in the fake DOM (via scopeText) but not
    // visible — mirrors the real montecarlo bug: the correct selector
    // matched a node that stayed hidden past the wait budget.
    const page = fakePage({ scopeText: { "[data-qa-minicart]": "" } });
    const { diagnostics } = await waitForCartReveal(page, null, ctxWith(), 30);
    const hidden = diagnostics.probes?.find((p) => p.selector === "[data-qa-minicart]");
    expect(hidden).toEqual({ selector: "[data-qa-minicart]", present: true, visible: false });
  });
});
