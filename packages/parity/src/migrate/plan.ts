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
 * `"pending"` for every row at creation time; the plugin flips it in-place via
 * {@link savePlan} as it ports each component.
 *
 * `partial` exists because a target can be half-wired: on FastStore a section
 * needs component + CMS schema + whitelist entry, so a schema with no
 * `index.tsx` registration (or the reverse) is neither pending nor done.
 * Reporting those as `pending` sends a porter to redo finished work.
 */
export type ComponentStatus = "pending" | "partial" | "done" | "skipped";

/**
 * Page readiness. A migrated storefront page is only live when BOTH the code
 * (route + sections) and the CMS content exist — on FastStore the code can be
 * complete while the page renders empty because content was never published.
 * Tracking that explicitly is what lets the orchestrator answer "which pages
 * are actually done?" instead of guessing from component status.
 */
export type PageStatus = "pending" | "code" | "done" | "skipped";

export interface PlanPage {
  path: string;
  kind: string;
  /** Absent in plans written before page tracking — read as `"pending"`. */
  status?: PageStatus;
}

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
  pages: PlanPage[];
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
    pages: bundle.pages.map((p) => ({ path: p.path, kind: p.kind, status: "pending" as const })),
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
 * Flip one page's readiness. Paths match exactly, then leniently (trailing
 * slash / missing leading slash), so `home`, `/home` and `/home/` all hit the
 * same row. Mutates in place; returns the matched row or null.
 */
export function setPageStatus(
  plan: MigrationPlan,
  path: string,
  status: PageStatus,
): PlanPage | null {
  const norm = (p: string) => `/${p.trim().replace(/^\/+|\/+$/g, "")}` || "/";
  const target = norm(path);
  const page =
    plan.pages.find((p) => p.path === path) ?? plan.pages.find((p) => norm(p.path) === target);
  if (!page) return null;
  page.status = status;
  return page;
}

export interface PlanProgress {
  components: {
    total: number;
    byStatus: Record<ComponentStatus, number>;
    /** Names that need no further work — `done` + `skipped`. */
    settled: string[];
    /** Names still to build — `pending` + `partial` (partial flagged separately). */
    remaining: { name: string; status: ComponentStatus; scope: string; origin: ComponentOrigin }[];
  };
  pages: {
    total: number;
    byStatus: Record<PageStatus, number>;
    /** Pages with code but no published content — the usual FastStore blocker. */
    awaitingContent: string[];
    remaining: { path: string; kind: string; status: PageStatus }[];
  };
}

/**
 * The migration's real state at a glance: what is settled, what remains, and
 * which pages have code but no content. This is the inventory the orchestrator
 * must read BEFORE triaging anything — without it, "what's missing" is unknown
 * and a survey degenerates into a lint pass over whatever the repo happens to
 * contain. Pure — unit-tested.
 */
export function planProgress(plan: MigrationPlan): PlanProgress {
  const compByStatus: Record<ComponentStatus, number> = {
    pending: 0,
    partial: 0,
    done: 0,
    skipped: 0,
  };
  const settled: string[] = [];
  const remaining: PlanProgress["components"]["remaining"] = [];
  for (const c of plan.components) {
    compByStatus[c.status] = (compByStatus[c.status] ?? 0) + 1;
    if (c.status === "done" || c.status === "skipped") settled.push(c.name);
    else
      remaining.push({
        name: c.name,
        status: c.status,
        scope: c.scope ?? "page",
        origin: c.origin,
      });
  }

  const pageByStatus: Record<PageStatus, number> = { pending: 0, code: 0, done: 0, skipped: 0 };
  const awaitingContent: string[] = [];
  const pagesRemaining: PlanProgress["pages"]["remaining"] = [];
  for (const p of plan.pages) {
    const status = p.status ?? "pending";
    pageByStatus[status] = (pageByStatus[status] ?? 0) + 1;
    if (status === "code") awaitingContent.push(p.path);
    if (status !== "done" && status !== "skipped") {
      pagesRemaining.push({ path: p.path, kind: p.kind, status });
    }
  }

  return {
    components: { total: plan.components.length, byStatus: compByStatus, settled, remaining },
    pages: {
      total: plan.pages.length,
      byStatus: pageByStatus,
      awaitingContent,
      remaining: pagesRemaining,
    },
  };
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
