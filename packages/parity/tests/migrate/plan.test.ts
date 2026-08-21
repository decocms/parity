import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type MigrationPlan,
  buildMigrationPlan,
  loadPlan,
  planProgress,
  savePlan,
  setPageStatus,
  syntheticSourceComponents,
} from "../../src/migrate/plan.ts";
import type { SourceComponent, SourceInventory } from "../../src/migrate/sources/types.ts";
import type { MigratedComponent, MigrationBundle } from "../../src/types/migrate.ts";

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

describe("setPageStatus", () => {
  function planWithPages(): MigrationPlan {
    const plan = buildMigrationPlan({
      bundle: bundleOf([]),
      source: { kind: "live-only", label: "Live", dir: null },
      inventory: inv([]),
    });
    plan.pages = [
      { path: "/", kind: "home", status: "pending" },
      { path: "/refrigeracion", kind: "plp", status: "pending" },
    ];
    return plan;
  }

  it("novas páginas do plano nascem como pending", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([]),
      source: { kind: "live-only", label: "Live", dir: null },
      inventory: inv([]),
    });
    expect(plan.pages[0]).toMatchObject({ path: "/", status: "pending" });
  });

  it("marca uma página como code (rota pronta, conteúdo faltando)", () => {
    const plan = planWithPages();
    expect(setPageStatus(plan, "/refrigeracion", "code")?.status).toBe("code");
    expect(plan.pages[1]!.status).toBe("code");
  });

  it("casa o path de forma tolerante (barra sobrando/faltando)", () => {
    const plan = planWithPages();
    expect(setPageStatus(plan, "refrigeracion/", "done")?.path).toBe("/refrigeracion");
  });

  it("retorna null quando a página não existe", () => {
    expect(setPageStatus(planWithPages(), "/inexistente", "done")).toBeNull();
  });
});

describe("planProgress", () => {
  it("separa componentes assentados dos que faltam, e páginas sem conteúdo", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([live("header", "global"), live("product-shelf", "page")]),
      source: { kind: "live-only", label: "Live", dir: null },
      inventory: inv([]),
    });
    plan.components = [
      { ...plan.components[0]!, name: "Navbar", status: "done" },
      { ...plan.components[1]!, name: "ProductShelf", status: "pending" },
      { ...plan.components[1]!, name: "Hero", status: "partial" },
      { ...plan.components[1]!, name: "PortalRoot", status: "skipped" },
    ];
    plan.pages = [
      { path: "/", kind: "home", status: "done" },
      { path: "/plp", kind: "plp", status: "code" },
      { path: "/pdp", kind: "pdp", status: "pending" },
    ];

    const p = planProgress(plan);
    expect(p.components.byStatus).toMatchObject({
      done: 1,
      pending: 1,
      partial: 1,
      skipped: 1,
    });
    // "não precisa mexer" = done + skipped
    expect(p.components.settled.sort()).toEqual(["Navbar", "PortalRoot"]);
    expect(p.components.remaining.map((r) => r.name).sort()).toEqual(["Hero", "ProductShelf"]);
    // páginas com código mas sem conteúdo publicado
    expect(p.pages.awaitingContent).toEqual(["/plp"]);
    expect(p.pages.byStatus).toMatchObject({ done: 1, code: 1, pending: 1 });
    expect(p.pages.remaining.map((r) => r.path).sort()).toEqual(["/pdp", "/plp"]);
  });

  it("trata página sem campo status (plano antigo) como pending", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([]),
      source: { kind: "live-only", label: "Live", dir: null },
      inventory: inv([]),
    });
    plan.pages = [{ path: "/", kind: "home" }];
    expect(planProgress(plan).pages.byStatus.pending).toBe(1);
  });
});
