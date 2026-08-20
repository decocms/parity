/**
 * `migration-plan.json` — the single contract between `parity migrate` and the
 * orchestration phases (the Claude Code plugin). Every phase reads THIS instead
 * of re-parsing the full bundle: it carries the source/target decision, the
 * page list, and one row per component reconciling what the CODE has against
 * what the LIVE capture saw.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MigratedComponent, MigrationBundle } from "../types/migrate.ts";
import type { SourceComponent, SourceInventory } from "./sources/types.ts";

/**
 * Per-component reconciliation of the two inventories:
 *  - `both`        — in the source code AND seen live (the confident rows).
 *  - `source-only` — defined in code but not observed live (unused/edge route).
 *  - `live-only`   — seen live but no source file (app-provided VTEX block, or
 *                    no source repo at all).
 */
export type ComponentOrigin = "both" | "source-only" | "live-only";

/**
 * Porting status, owned by the orchestrator (not `parity migrate`). Written as
 * `"pending"` for every row at creation time; the plugin flips it to `"done"`
 * or `"skipped"` in-place via {@link savePlan} as it ports each component.
 */
export type ComponentStatus = "pending" | "done" | "skipped";

export interface PlanComponent {
  name: string;
  role: string;
  scope: "global" | "page" | null;
  origin: ComponentOrigin;
  status: ComponentStatus;
  /** Repo-relative source file, when the code defines it. */
  file: string | null;
}

export interface MigrationPlan {
  url: string;
  timestamp: string;
  source: { kind: string; label: string; dir: string | null; notes: string[] };
  target: { name: string | null };
  pages: { path: string; kind: string }[];
  components: PlanComponent[];
}

/** Normalize a name for cross-inventory matching (case + separators). */
function key(name: string): string {
  return name.toLowerCase().replace(/[\s_/-]+/g, "");
}

export function buildMigrationPlan(input: {
  bundle: MigrationBundle;
  source: { kind: string; label: string; dir: string | null };
  inventory: SourceInventory;
}): MigrationPlan {
  const { bundle, source, inventory } = input;

  const liveByKey = new Map<string, { role: string; scope: "global" | "page" }>();
  for (const c of bundle.components) {
    liveByKey.set(key(c.role), { role: c.role, scope: c.scope });
  }
  const srcByKey = new Map<string, SourceComponent>();
  for (const c of inventory.components) srcByKey.set(key(c.name), c);

  const components: PlanComponent[] = [];
  // Source rows first (code is the authoritative name), tagged both/source-only.
  for (const [k, c] of srcByKey) {
    components.push({
      name: c.name,
      role: c.role,
      scope: c.scope,
      origin: liveByKey.has(k) ? "both" : "source-only",
      status: "pending",
      file: c.file,
    });
  }
  // Live-only rows: seen in the DOM but with no source file.
  for (const [k, c] of liveByKey) {
    if (srcByKey.has(k)) continue;
    components.push({
      name: c.role,
      role: c.role,
      scope: c.scope,
      origin: "live-only",
      status: "pending",
      file: null,
    });
  }

  return {
    url: bundle.url,
    timestamp: bundle.timestamp,
    source: { kind: source.kind, label: source.label, dir: source.dir, notes: inventory.notes },
    target: { name: bundle.target ?? null },
    pages: bundle.pages.map((p) => ({ path: p.path, kind: p.kind })),
    components,
  };
}

const PLAN_FILE = "migration-plan.json";

/** Read `migration-plan.json` from a run dir, or null when absent. */
export function loadPlan(dir: string): MigrationPlan | null {
  const p = join(dir, PLAN_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as MigrationPlan;
}

/** Write `migration-plan.json` to a run dir (the orchestrator updates it in-place). */
export function savePlan(dir: string, plan: MigrationPlan): void {
  writeFileSync(join(dir, PLAN_FILE), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

/**
 * Flip one component's porting status, matching `name` with the same
 * case/separator-insensitive rule the reconciler uses. Mutates the plan in
 * place; returns the matched row, or null when no component matches. Backs the
 * `parity plan set-status` command the orchestrator calls instead of hand-editing
 * the JSON.
 */
export function setComponentStatus(
  plan: MigrationPlan,
  name: string,
  status: ComponentStatus,
): PlanComponent | null {
  const k = key(name);
  const component = plan.components.find((c) => key(c.name) === k);
  if (!component) return null;
  component.status = status;
  return component;
}

/**
 * Source-only components as synthetic `MigratedComponent`s — defined in the
 * code but never seen live, so their capture fields are empty. Merged into the
 * bundle so the exporters and MIGRATION_PROMPT.md list them for porting (they'd
 * otherwise be invisible to an agent reading only the live capture).
 */
export function syntheticSourceComponents(plan: MigrationPlan): MigratedComponent[] {
  return plan.components
    .filter((c) => c.origin === "source-only")
    .map((c) => ({
      role: c.name,
      selector: "",
      html: "",
      computedStyles: null,
      screenshotPath: "",
      assets: { images: [], backgroundImages: [], fonts: [] },
      links: [],
      textContent: [],
      tailwind: [],
      interactions: [],
      scope: c.scope ?? "page",
      synthetic: true,
    }));
}
