import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMigrationPlan,
  loadPlan,
  type MigrationPlan,
  savePlan,
  syntheticSourceComponents,
} from "../../src/migrate/plan.ts";
import type { MigratedComponent, MigrationBundle } from "../../src/types/migrate.ts";
import type { SourceComponent, SourceInventory } from "../../src/migrate/sources/types.ts";

/** Minimal live component — buildMigrationPlan only reads role + scope. */
function live(role: string, scope: "global" | "page"): MigratedComponent {
  return {
    role,
    selector: `.${role}`,
    html: "",
    computedStyles: null,
    screenshotPath: "",
    assets: { images: [], backgroundImages: [], fonts: [] },
    links: [],
    textContent: [],
    tailwind: [],
    interactions: [],
    scope,
  };
}

/** Minimal bundle — only the fields buildMigrationPlan touches are real. */
function bundleOf(components: MigratedComponent[]): MigrationBundle {
  return {
    url: "https://shop.example",
    timestamp: "2026-08-19T00:00:00.000Z",
    target: "faststore",
    pages: [{ path: "/", kind: "home" }],
    components,
  } as unknown as MigrationBundle;
}

function src(name: string, role: string, scope: "global" | "page" | null): SourceComponent {
  return { name, file: `src/sections/${name}.tsx`, role, scope };
}

function inv(components: SourceComponent[], notes: string[] = []): SourceInventory {
  return { components, notes };
}

describe("buildMigrationPlan — origin reconciliation", () => {
  it("tags a component present in both code and live capture as `both`", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([live("Hero", "page")]),
      source: { kind: "deco-fresh", label: "Deco/Fresh", dir: "/repo" },
      inventory: inv([src("Hero", "section", "page")]),
    });
    const hero = plan.components.find((c) => c.name === "Hero");
    expect(hero?.origin).toBe("both");
    expect(hero?.file).toBe("src/sections/Hero.tsx");
  });

  it("tags a code-only component as `source-only`", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([]),
      source: { kind: "deco-fresh", label: "Deco/Fresh", dir: "/repo" },
      inventory: inv([src("UnusedBanner", "section", "page")]),
    });
    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]!.origin).toBe("source-only");
  });

  it("tags a live-only component (no source file) as `live-only`", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([live("product-summary", "page")]),
      source: { kind: "vtex-io", label: "VTEX IO", dir: "/repo" },
      inventory: inv([]),
    });
    expect(plan.components[0]!.origin).toBe("live-only");
    expect(plan.components[0]!.file).toBeNull();
  });

  it("matches across case and separator differences", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([live("product_summary", "page")]),
      source: { kind: "vtex-io", label: "VTEX IO", dir: "/repo" },
      inventory: inv([src("ProductSummary", "component", "page")]),
    });
    // One reconciled row, not two — `product_summary` == `ProductSummary`.
    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]!.origin).toBe("both");
  });

  it("produces a valid plan in live-only mode (empty source inventory)", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([live("header", "global"), live("footer", "global")]),
      source: { kind: "live-only", label: "Live site only", dir: null },
      inventory: inv([], ["scraped from DOM"]),
    });
    expect(plan.components.map((c) => c.origin)).toEqual(["live-only", "live-only"]);
    expect(plan.source.dir).toBeNull();
    expect(plan.source.notes).toEqual(["scraped from DOM"]);
  });

  it("defaults every component's status to `pending`", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([live("Hero", "page")]),
      source: { kind: "deco-fresh", label: "Deco/Fresh", dir: "/repo" },
      inventory: inv([src("Nav", "section", "global")]),
    });
    expect(plan.components.every((c) => c.status === "pending")).toBe(true);
  });
});

describe("savePlan / loadPlan", () => {
  it("round-trips a plan and returns null when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "parity-plan-"));
    try {
      expect(loadPlan(dir)).toBeNull();
      const plan = buildMigrationPlan({
        bundle: bundleOf([live("Hero", "page")]),
        source: { kind: "deco-fresh", label: "Deco/Fresh", dir: "/repo" },
        inventory: inv([src("Hero", "section", "page")]),
      });
      savePlan(dir, plan);
      const loaded = loadPlan(dir) as MigrationPlan;
      expect(loaded).toEqual(plan);
      // The orchestrator flips status in-place and re-saves.
      loaded.components[0]!.status = "done";
      savePlan(dir, loaded);
      expect(loadPlan(dir)!.components[0]!.status).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("syntheticSourceComponents", () => {
  it("emits one synthetic MigratedComponent per source-only row, empty capture", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([live("Hero", "page")]),
      source: { kind: "deco-fresh", label: "Deco/Fresh", dir: "/repo" },
      inventory: inv([src("Hero", "section", "page"), src("UnusedBanner", "section", "global")]),
    });
    const synthetic = syntheticSourceComponents(plan);
    expect(synthetic).toHaveLength(1);
    const banner = synthetic[0]!;
    expect(banner.role).toBe("UnusedBanner");
    expect(banner.synthetic).toBe(true);
    expect(banner.scope).toBe("global");
    expect(banner.html).toBe("");
    expect(banner.tailwind).toEqual([]);
  });

  it("defaults null scope to `page`", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([]),
      source: { kind: "deco-fresh", label: "Deco/Fresh", dir: "/repo" },
      inventory: inv([src("Loose", "section", null)]),
    });
    expect(syntheticSourceComponents(plan)[0]!.scope).toBe("page");
  });
});
