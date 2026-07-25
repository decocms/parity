import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Recipe = a per-component script that drives BOTH prod and cand to the same
 * interactive state (megamenu hovered, minicart open, …) before the section
 * diff runs. Ports the Step DSL from the athens `scripts/ui-spec` harness so
 * there's one mental model across the two tools.
 *
 * Steps run identically on both pages inside `gatherSide`, so prod/cand
 * symmetry is free. Per-side `url`/`selector`/`steps` let prod (VTEX classes)
 * and cand (local `data-ui`/semantic tags) reach the same visual state by
 * different paths.
 */
export const RecipeStep = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("waitFor"),
    selector: z.string(),
    timeout: z.number().optional(),
  }),
  z.object({
    action: z.literal("click"),
    selector: z.string(),
    /** Don't fail if the target is missing (cookie banners, etc.). */
    optional: z.boolean().optional(),
  }),
  z.object({ action: z.literal("hover"), selector: z.string() }),
  z.object({ action: z.literal("focus"), selector: z.string() }),
  z.object({ action: z.literal("type"), selector: z.string(), text: z.string() }),
  z.object({ action: z.literal("sleep"), ms: z.number() }),
  /** Scroll to y (default: bottom of document). */
  z.object({ action: z.literal("scroll"), y: z.number().optional() }),
  /** Run JS on the page (async-wrapped, awaited) — the state-injection escape hatch. */
  z.object({ action: z.literal("eval"), script: z.string() }),
  z.object({ action: z.literal("reload") }),
]);
export type RecipeStep = z.infer<typeof RecipeStep>;

const RecipeSide = z.object({
  url: z.string().url(),
  steps: z.array(RecipeStep).optional(),
  /** Selector for THIS side; falls back to the top-level `selector`. */
  selector: z.string().optional(),
});
export type RecipeSide = z.infer<typeof RecipeSide>;

export const Recipe = z.object({
  viewport: z.enum(["mobile", "tablet", "desktop"]).optional(),
  /** Shared selector when a side doesn't set its own. */
  selector: z.string().optional(),
  /** Convergence threshold (heatmap % pixels differing) for the exit code. */
  maxPctDiff: z.number().optional(),
  prod: RecipeSide,
  cand: RecipeSide,
});
export type Recipe = z.infer<typeof Recipe>;

/** Load + validate a recipe JSON file; throws with a readable message. */
export function loadRecipe(path: string): Recipe {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`não consegui ler a recipe '${path}': ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`recipe '${path}' não é JSON válido: ${(err as Error).message}`);
  }
  const result = Recipe.safeParse(parsed);
  if (!result.success) {
    throw new Error(`recipe '${path}' inválida: ${result.error.message}`);
  }
  if (!result.data.selector && !result.data.prod.selector && !result.data.cand.selector) {
    throw new Error(`recipe '${path}': defina um 'selector' (top-level ou por lado)`);
  }
  return result.data;
}
