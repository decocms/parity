import type { Page } from "playwright";
import type { RecipeStep } from "./recipe.ts";

/**
 * Executes recipe steps against a Playwright page to drive it to the target
 * interactive state before a section capture. Ported from the athens
 * `scripts/ui-spec/browser.ts:runSteps` (astral → playwright). Runs the SAME
 * step list on prod and cand so both reach the same visual state.
 *
 * Gotchas carried over: `waitFor` defaults to 15s (VTEX is slow); `hover`
 * moves a real pointer to the element (needed for JS dropdowns / megamenu)
 * with a 200ms settle; `eval` is async-wrapped so `await` works inside
 * injected code (e.g. the orderForm POST that fills the minicart).
 */
export async function runRecipeSteps(page: Page, steps: RecipeStep[]): Promise<void> {
  for (const step of steps) {
    switch (step.action) {
      case "waitFor":
        await page.waitForSelector(step.selector, { timeout: step.timeout ?? 15_000 });
        break;
      case "sleep":
        await page.waitForTimeout(step.ms);
        break;
      case "click": {
        const loc = page.locator(step.selector).first();
        if ((await loc.count()) === 0) {
          if (step.optional) break;
          throw new Error(`click: seletor não encontrado: ${step.selector}`);
        }
        await loc.click({ timeout: 10_000 });
        break;
      }
      case "hover": {
        const loc = page.locator(step.selector).first();
        await loc.waitFor({ timeout: 15_000 });
        // force skips actionability waits that JS-driven menus can trip on;
        // the mouse-move is what opens VTEX hover dropdowns.
        await loc.hover({ timeout: 10_000, force: true });
        await page.waitForTimeout(200);
        break;
      }
      case "focus": {
        const loc = page.locator(step.selector).first();
        await loc.waitFor({ timeout: 15_000 });
        await loc.focus();
        break;
      }
      case "type": {
        const loc = page.locator(step.selector).first();
        await loc.waitFor({ timeout: 15_000 });
        await loc.click();
        await page.keyboard.type(step.text, { delay: 40 });
        break;
      }
      case "scroll":
        await page.evaluate((y) => globalThis.scrollTo(0, y ?? document.body.scrollHeight), step.y);
        break;
      case "eval":
        // async-wrapped so injected code can `await` (orderForm POST, etc.)
        await page.evaluate(`(async () => { ${step.script} })()`);
        break;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        break;
    }
  }
}
