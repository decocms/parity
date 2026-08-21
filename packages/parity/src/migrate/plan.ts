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
/**
 * `as-is` and `upgrade` both mean "stop opening work for this", for opposite reasons, and the
 * difference matters: `as-is` accepts a delta against prod, `upgrade` says prod is no longer
 * the reference for this component because the target deliberately moved ahead (a better
 * component brought in from elsewhere). Collapsing them into `skipped` loses the only fact a
 * reader wants — was this abandoned, tolerated, or improved.
 */
export type ComponentStatus = "pending" | "partial" | "done" | "as-is" | "upgrade" | "skipped";

/**
 * Where a component is validated against, when it is NOT prod. Set for `upgrade` rows whose
 * component came from another site: `parity section --prod <url>` takes any URL, so pointing a
 * component's comparison somewhere else needs no new machinery.
 *
 * `note` is not optional by accident. An `upgrade` with no written reason is indistinguishable
 * from a forgotten gap six months later.
 */
export interface ComponentReference {
  url: string;
  /** Selector on the reference site; falls back to the component's captured selector. */
  selector: string | null;
  note: string;
}

/** One recorded validation. `against` is what makes a pass meaningful. */
export interface ComponentVerification {
  at: string;
  verdict: "pass" | "fail";
  against: "prod" | "reference";
  note?: string;
}

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
  /**
   * Component names the capture saw on this page. This is what turns a flat component list into
   * per-page work: without it there is no answer to "what is left on the PDP?". Absent in plans
   * written before page/component edges — read as "unknown", not "none".
   */
  components?: string[];
}

export interface PlanComponent {
  name: string;
  role: string;
  scope: "global" | "page" | null;
  origin: ComponentOrigin;
  status: ComponentStatus;
  /** Repo-relative source file, when the code defines it. */
  file: string | null;
  /** Captured CSS selector on the SOURCE side — feeds `parity section --selector`. */
  selector?: string | null;
  /** Non-prod reference for this component. See {@link ComponentReference}. */
  reference?: ComponentReference | null;
  /** Last recorded validation, or null when the component was never checked. */
  verified?: ComponentVerification | null;
}

export interface MigrationPlan {
  url: string;
  timestamp: string;
  source: { kind: string; label: string; dir: string | null; notes: string[] };
  target: { name: string | null };
  pages: PlanPage[];
  components: PlanComponent[];
}

function dedupe(names: string[]): string[] {
  return [...new Set(names)];
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

  const liveByKey = new Map<string, { role: string; scope: "global" | "page"; selector: string }>();
  for (const c of bundle.components) {
    liveByKey.set(key(c.role), { role: c.role, scope: c.scope, selector: c.selector });
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
      selector: liveByKey.get(k)?.selector ?? null,
      reference: null,
      verified: null,
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
      selector: c.selector,
      reference: null,
      verified: null,
    });
  }

  return {
    url: bundle.url,
    timestamp: bundle.timestamp,
    source: { kind: source.kind, label: source.label, dir: source.dir, notes: inventory.notes },
    target: { name: bundle.target ?? null },
    pages: bundle.pages.map((p) => ({
      path: p.path,
      kind: p.kind,
      status: "pending" as const,
      // The capture already knows which components each page holds; carrying it here is what
      // makes per-page work possible. Names are resolved back to plan rows through `key()`.
      components: dedupe(
        (p.components ?? []).map(
          (c) => components.find((row) => key(row.name) === key(c.role))?.name ?? c.role,
        ),
      ),
    })),
    components,
  };
}

const PLAN_FILE = "migration-plan.json";

/** Statuses that mean "no further work", whatever the reason. */
const SETTLED = new Set<ComponentStatus>(["done", "as-is", "upgrade", "skipped"]);

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
  const page = findPage(plan, path);
  if (!page) return null;
  page.status = status;
  return page;
}

/**
 * Locate a page by path: exact first, then leniently (trailing slash / missing leading slash),
 * so `home`, `/home` and `/home/` all hit the same row. Shared by every page-scoped read.
 */
export function findPage(plan: MigrationPlan, path: string): PlanPage | null {
  const norm = (p: string) => `/${p.trim().replace(/^\/+|\/+$/g, "")}` || "/";
  const target = norm(path);
  return (
    plan.pages.find((p) => p.path === path) ??
    plan.pages.find((p) => norm(p.path) === target) ??
    null
  );
}

export interface PlanProgress {
  components: {
    total: number;
    byStatus: Record<ComponentStatus, number>;
    /** Names that need no further work — `done`, `as-is`, `upgrade`, `skipped`. */
    settled: string[];
    /**
     * The two deliberate outcomes, kept apart from `settled` because "we tolerated a
     * difference" and "we did it better" are the two lines a stakeholder actually asks about.
     */
    accepted: { asIs: string[]; upgrade: string[] };
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
    "as-is": 0,
    upgrade: 0,
    skipped: 0,
  };
  const settled: string[] = [];
  const accepted: PlanProgress["components"]["accepted"] = { asIs: [], upgrade: [] };
  const remaining: PlanProgress["components"]["remaining"] = [];
  for (const c of plan.components) {
    compByStatus[c.status] = (compByStatus[c.status] ?? 0) + 1;
    if (c.status === "as-is") accepted.asIs.push(c.name);
    if (c.status === "upgrade") accepted.upgrade.push(c.name);
    if (SETTLED.has(c.status)) settled.push(c.name);
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
    components: {
      total: plan.components.length,
      byStatus: compByStatus,
      settled,
      accepted,
      remaining,
    },
    pages: {
      total: plan.pages.length,
      byStatus: pageByStatus,
      awaitingContent,
      remaining: pagesRemaining,
    },
  };
}

/**
 * What to do about one component on one page. Derived from the plan, never stored: a second
 * task store drifts from the plan on the first round, and then neither is trustworthy.
 *
 *  - `build`    — not there yet (`pending` / `partial`).
 *  - `validate` — code exists but was never checked against its reference.
 *  - `upgrade`  — deliberately ahead of prod with no reference to check against, so the only
 *                 honest task is human review. With a reference it becomes `validate`.
 *  - `as-is`    — accepted divergence. No task; listed so nobody re-raises it.
 *  - `settled`  — validated, or explicitly skipped.
 */
export type Disposition = "build" | "validate" | "upgrade" | "as-is" | "settled";

export interface PageTask {
  name: string;
  disposition: Disposition;
  status: ComponentStatus;
  scope: string;
  origin: ComponentOrigin;
  selector: string | null;
  /** Base URL the validation compares against — the reference site, or prod. */
  against: { url: string; kind: "prod" | "reference" } | null;
  /** Runnable `parity section` invocation, or null when no automatic check is possible. */
  command: string | null;
  /** Why this component is `as-is` / `upgrade`, from its reference note. */
  note: string | null;
}

export interface PagePlan {
  path: string;
  kind: string;
  status: PageStatus;
  /** Null when the plan predates page/component edges — unknown, which is not the same as none. */
  tasks: PageTask[] | null;
  counts: Record<Disposition, number>;
  /** True when nothing is left to build or validate on this page. */
  ready: boolean;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`.replace(/\/$/, "") || base;
}

function shellQuote(value: string): string {
  return /^[\w./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function disposition(c: PlanComponent): Disposition {
  if (c.status === "pending" || c.status === "partial") return "build";
  if (c.status === "skipped") return "settled";
  if (c.status === "as-is") return "as-is";
  if (c.verified) return "settled";
  // `upgrade` is only checkable when someone said what to check it against.
  if (c.status === "upgrade") return c.reference ? "validate" : "upgrade";
  return "validate";
}

/**
 * The per-page worksheet: every component the capture saw on `path`, each with what to do about
 * it and — for the checkable ones — a ready-to-run `parity section` command. Pure; the CLI and
 * the orchestrator both read this instead of re-deriving the rules.
 *
 * `candUrl` is a parameter rather than a plan field on purpose: the plan describes the capture,
 * not whichever environment happens to be running.
 */
export function pagePlan(plan: MigrationPlan, path: string, candUrl?: string): PagePlan | null {
  const page = findPage(plan, path);
  if (!page) return null;

  const counts: Record<Disposition, number> = {
    build: 0,
    validate: 0,
    upgrade: 0,
    "as-is": 0,
    settled: 0,
  };

  let tasks: PageTask[] | null = null;
  if (page.components) {
    tasks = [];
    for (const name of page.components) {
      const c = plan.components.find((row) => key(row.name) === key(name));
      if (!c) continue;

      const d = disposition(c);
      counts[d] += 1;

      const selector = c.reference?.selector ?? c.selector ?? null;
      const refUrl = c.reference?.url ?? plan.url;
      const kind: "prod" | "reference" = c.reference ? "reference" : "prod";
      const checkable = d === "validate" && Boolean(selector) && Boolean(candUrl);

      tasks.push({
        name: c.name,
        disposition: d,
        status: c.status,
        scope: c.scope ?? "page",
        origin: c.origin,
        selector,
        against: d === "validate" ? { url: refUrl, kind } : null,
        command:
          checkable && candUrl && selector
            ? `parity section --prod ${shellQuote(joinUrl(refUrl, page.path))} --cand ${shellQuote(
                joinUrl(candUrl, page.path),
              )} --selector ${shellQuote(selector)}`
            : null,
        note: c.reference?.note ?? null,
      });
    }
  }

  return {
    path: page.path,
    kind: page.kind,
    status: page.status ?? "pending",
    tasks,
    counts,
    ready: counts.build === 0 && counts.validate === 0,
  };
}

/**
 * Record a validation result. A `done` component with no verification is not the same as a
 * checked one, and `against` is what makes a pass mean anything.
 */
export function setComponentVerified(
  plan: MigrationPlan,
  name: string,
  verdict: "pass" | "fail",
  at: string,
  note?: string,
): PlanComponent | null {
  const k = key(name);
  const component = plan.components.find((c) => key(c.name) === k);
  if (!component) return null;
  // What it was checked against follows from the row, so a caller cannot get the pair wrong.
  const against: ComponentVerification["against"] = component.reference ? "reference" : "prod";
  component.verified = { at, verdict, against, ...(note ? { note } : {}) };
  return component;
}

/** Point a component's comparison at a non-prod reference. */
export function setComponentReference(
  plan: MigrationPlan,
  name: string,
  reference: ComponentReference,
): PlanComponent | null {
  const k = key(name);
  const component = plan.components.find((c) => key(c.name) === k);
  if (!component) return null;
  component.reference = reference;
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
