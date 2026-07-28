import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { isCartRevealed, isCartUiVisible } from "../../../src/engine/flows/cart-helpers.ts";
import type { FlowContext } from "../../../src/engine/flows/shared.ts";
import { selectorsFor } from "../../../src/engine/selectors.ts";
import type { ParityRc } from "../../../src/types/schema.ts";

/**
 * Fake `Page` exposing just what the reveal-detection helpers touch:
 * `locator(sel).first().isVisible()`, `.count()`, and `.first().innerText()`.
 * `visible` = selectors that report visible; `scopeText` = innerText per
 * selector (also makes `count()` return 1 for that selector).
 */
function fakePage(opts: { visible?: string[]; scopeText?: Record<string, string> } = {}): Page {
  const visible = new Set(opts.visible ?? []);
  const scopeText = opts.scopeText ?? {};
  return {
    locator: (sel: string) => ({
      first: () => ({
        isVisible: () => Promise.resolve(visible.has(sel)),
        innerText: () => Promise.resolve(scopeText[sel] ?? ""),
      }),
      count: () => Promise.resolve(sel in scopeText || visible.has(sel) ? 1 : 0),
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
