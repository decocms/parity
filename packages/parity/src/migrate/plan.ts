/**
 * `migration-plan.json` — the single contract between `parity migrate` and the
 * orchestration phases (the Claude Code plugin). Every phase reads THIS instead
 * of re-parsing the full bundle: it carries the source/target decision, the
 * page list, and one row per component reconciling what the CODE has against
 * what the LIVE capture saw.
 */

import type { SourceComponent, SourceInventory } from "./sources/types.ts";
import type { MigrationBundle } from "../types/migrate.ts";

/**
 * Per-component reconciliation of the two inventories:
 *  - `both`        — in the source code AND seen live (the confident rows).
 *  - `source-only` — defined in code but not observed live (unused/edge route).
 *  - `live-only`   — seen live but no source file (app-provided VTEX block, or
 *                    no source repo at all).
 */
export type ComponentOrigin = "both" | "source-only" | "live-only";

export interface PlanComponent {
  name: string;
  role: string;
  scope: "global" | "page" | null;
  origin: ComponentOrigin;
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
      file: c.file,
    });
  }
  // Live-only rows: seen in the DOM but with no source file.
  for (const [k, c] of liveByKey) {
    if (srcByKey.has(k)) continue;
    components.push({ name: c.role, role: c.role, scope: c.scope, origin: "live-only", file: null });
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
