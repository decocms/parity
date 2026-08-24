import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type MigrationPlan,
  buildMigrationPlan,
  loadPlan,
  mergePlanDecisions,
  pageColumn,
  pagePlan,
  planBoard,
  planProgress,
  savePlan,
  setComponentReference,
  setComponentStatus,
  setComponentVerified,
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
function bundleOf(
  components: MigratedComponent[],
  pages?: { path: string; kind: string; components?: MigratedComponent[] }[],
): MigrationBundle {
  return {
    url: "https://shop.example",
    timestamp: "2026-08-19T00:00:00.000Z",
    target: "faststore",
    pages: pages ?? [{ path: "/", kind: "home" }],
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

describe("buildMigrationPlan — page/component edges", () => {
  it("carries each page's components from the capture into the plan", () => {
    const navbar = live("navbar", "global");
    const shelf = live("product-shelf", "page");
    const plan = buildMigrationPlan({
      bundle: bundleOf(
        [navbar, shelf],
        [
          { path: "/", kind: "home", components: [navbar, shelf] },
          { path: "/p", kind: "pdp", components: [navbar] },
        ],
      ),
      source: { kind: "vtex-io", label: "VTEX IO", dir: null },
      inventory: inv([]),
    });

    expect(new Set(plan.pages[0]?.components)).toEqual(new Set(["navbar", "product-shelf"]));
    expect(plan.pages[1]?.components).toEqual(["navbar"]);
  });

  it("resolves a page's component to the plan row's name, not the raw role", () => {
    const shelf = live("product-shelf", "page");
    const plan = buildMigrationPlan({
      bundle: bundleOf([shelf], [{ path: "/", kind: "home", components: [shelf] }]),
      source: { kind: "deco-fresh", label: "Fresh", dir: "/tmp/src" },
      // Code calls it ProductShelf; the capture calls it product-shelf. One row, code's name.
      inventory: inv([src("ProductShelf", "product-shelf", "page")]),
    });

    expect(plan.components).toHaveLength(1);
    expect(plan.pages[0]?.components).toEqual(["ProductShelf"]);
  });

  it("dedupes a component repeated on the same page", () => {
    const card = live("product-card", "page");
    const plan = buildMigrationPlan({
      bundle: bundleOf([card], [{ path: "/", kind: "home", components: [card, card, card] }]),
      source: { kind: "vtex-io", label: "VTEX IO", dir: null },
      inventory: inv([]),
    });

    expect(plan.pages[0]?.components).toEqual(["product-card"]);
  });

  it("survives a bundle whose pages carry no component list", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([live("navbar", "global")], [{ path: "/", kind: "home" }]),
      source: { kind: "vtex-io", label: "VTEX IO", dir: null },
      inventory: inv([]),
    });

    expect(plan.pages[0]?.components).toEqual([]);
  });

  it("captures each component's selector so `parity section` can be built later", () => {
    const plan = buildMigrationPlan({
      bundle: bundleOf([live("navbar", "global")]),
      source: { kind: "vtex-io", label: "VTEX IO", dir: null },
      inventory: inv([]),
    });

    expect(plan.components[0]?.selector).toBe(".navbar");
  });
});

/** A plan with one page holding every component under test. */
function planWith(names: string[]): MigrationPlan {
  const comps = names.map((n) => live(n, "page"));
  return buildMigrationPlan({
    bundle: bundleOf(comps, [{ path: "/p", kind: "pdp", components: comps }]),
    source: { kind: "vtex-io", label: "VTEX IO", dir: null },
    inventory: inv([]),
  });
}

describe("pagePlan — disposition per component", () => {
  it("classifies pending and partial as build", () => {
    const plan = planWith(["a", "b"]);
    setComponentStatus(plan, "b", "partial");

    const page = pagePlan(plan, "/p");
    expect(page?.counts.build).toBe(2);
    expect(page?.ready).toBe(false);
  });

  it("classifies done-but-unchecked as validate, and done-and-checked as settled", () => {
    const plan = planWith(["a", "b"]);
    setComponentStatus(plan, "a", "done");
    setComponentStatus(plan, "b", "done");
    setComponentVerified(plan, "b", "pass", "2026-08-21T00:00:00.000Z");

    const page = pagePlan(plan, "/p");
    expect(page?.counts.validate).toBe(1);
    expect(page?.counts.settled).toBe(1);
    expect(page?.tasks?.find((t) => t.name === "a")?.disposition).toBe("validate");
  });

  it("classifies as-is with no task and skipped as settled", () => {
    const plan = planWith(["a", "b"]);
    setComponentStatus(plan, "a", "as-is");
    setComponentStatus(plan, "b", "skipped");

    const page = pagePlan(plan, "/p");
    expect(page?.counts["as-is"]).toBe(1);
    expect(page?.counts.settled).toBe(1);
    expect(page?.tasks?.find((t) => t.name === "a")?.command).toBeNull();
    expect(page?.ready).toBe(true);
  });

  it("leaves an upgrade with no reference as human review, not a validation", () => {
    const plan = planWith(["a"]);
    setComponentStatus(plan, "a", "upgrade");

    const page = pagePlan(plan, "/p", "https://cand.example");
    expect(page?.counts.upgrade).toBe(1);
    expect(page?.counts.validate).toBe(0);
    expect(page?.tasks?.[0]?.command).toBeNull();
    // Nothing left to build or check automatically.
    expect(page?.ready).toBe(true);
  });

  it("validates an upgrade against its reference site instead of prod", () => {
    const plan = planWith(["a"]);
    setComponentStatus(plan, "a", "upgrade");
    setComponentReference(plan, "a", {
      url: "https://other.example",
      selector: ".hero-v2",
      note: "brought over from the other storefront, deliberately ahead",
    });

    const page = pagePlan(plan, "/p", "https://cand.example");
    const task = page?.tasks?.[0];
    expect(task?.disposition).toBe("validate");
    expect(task?.against).toEqual({ url: "https://other.example", kind: "reference" });
    expect(task?.command).toBe(
      "parity section --prod https://other.example/p --cand https://cand.example/p --selector .hero-v2",
    );
    expect(task?.note).toContain("deliberately ahead");
  });

  it("points a plain validation at the prod URL from the plan", () => {
    const plan = planWith(["a"]);
    setComponentStatus(plan, "a", "done");

    const task = pagePlan(plan, "/p", "https://cand.example")?.tasks?.[0];
    expect(task?.against).toEqual({ url: "https://shop.example", kind: "prod" });
    expect(task?.command).toBe(
      "parity section --prod https://shop.example/p --cand https://cand.example/p --selector .a",
    );
  });

  it("omits the command when no candidate URL is given", () => {
    const plan = planWith(["a"]);
    setComponentStatus(plan, "a", "done");

    const page = pagePlan(plan, "/p");
    expect(page?.counts.validate).toBe(1);
    expect(page?.tasks?.[0]?.command).toBeNull();
  });

  it("matches the page path leniently and returns null for an unknown one", () => {
    const plan = planWith(["a"]);
    expect(pagePlan(plan, "p")?.path).toBe("/p");
    expect(pagePlan(plan, "/p/")?.path).toBe("/p");
    expect(pagePlan(plan, "/nope")).toBeNull();
  });

  it("reports unknown (null) tasks for a plan written before page/component edges", () => {
    const plan = planWith(["a"]);
    // Simulate a plan from before the edges existed.
    const page0 = plan.pages[0];
    if (page0) delete page0.components;

    const page = pagePlan(plan, "/p");
    expect(page?.tasks).toBeNull();
    expect(page?.ready).toBe(true);
  });
});

describe("setComponentVerified", () => {
  it("records `reference` when the component has one, `prod` otherwise", () => {
    const plan = planWith(["a", "b"]);
    setComponentReference(plan, "a", { url: "https://other.example", selector: null, note: "why" });

    setComponentVerified(plan, "a", "pass", "2026-08-21T00:00:00.000Z");
    setComponentVerified(plan, "b", "fail", "2026-08-21T00:00:00.000Z", "hero is 40px shorter");

    expect(plan.components.find((c) => c.name === "a")?.verified).toEqual({
      at: "2026-08-21T00:00:00.000Z",
      verdict: "pass",
      against: "reference",
    });
    expect(plan.components.find((c) => c.name === "b")?.verified).toEqual({
      at: "2026-08-21T00:00:00.000Z",
      verdict: "fail",
      against: "prod",
      note: "hero is 40px shorter",
    });
  });

  it("returns null for an unknown component", () => {
    expect(
      setComponentVerified(planWith(["a"]), "zzz", "pass", "2026-08-21T00:00:00.000Z"),
    ).toBeNull();
  });
});

describe("planProgress — deliberate outcomes", () => {
  it("counts as-is and upgrade as settled but reports them apart", () => {
    const plan = planWith(["a", "b", "c", "d"]);
    setComponentStatus(plan, "a", "as-is");
    setComponentStatus(plan, "b", "upgrade");
    setComponentStatus(plan, "c", "done");

    const p = planProgress(plan);
    expect(p.components.accepted).toEqual({ asIs: ["a"], upgrade: ["b"] });
    expect(new Set(p.components.settled)).toEqual(new Set(["a", "b", "c"]));
    expect(p.components.remaining.map((r) => r.name)).toEqual(["d"]);
    expect(p.components.byStatus["as-is"]).toBe(1);
    expect(p.components.byStatus.upgrade).toBe(1);
  });
});

describe("mergePlanDecisions", () => {
  /** A freshly captured plan — every row `pending`, the way buildMigrationPlan writes it. */
  function fresh(names: string[]): MigrationPlan {
    return planWith(names);
  }

  it("returns the fresh plan untouched when there is nothing to merge", () => {
    const f = fresh(["a"]);
    const out = mergePlanDecisions(f, null);
    expect(out.plan).toBe(f);
    expect(out.carried).toEqual([]);
    expect(out.droppedWithDecisions).toEqual([]);
  });

  it("carries status, reference and verification onto the fresh rows", () => {
    const previous = fresh(["a", "b", "c"]);
    setComponentStatus(previous, "a", "done");
    setComponentStatus(previous, "b", "upgrade");
    setComponentReference(previous, "b", {
      url: "https://other.example",
      selector: ".v2",
      note: "better one from the other site",
    });
    setComponentVerified(previous, "b", "pass", "2026-08-21T00:00:00.000Z");

    const out = mergePlanDecisions(fresh(["a", "b", "c"]), previous);
    const a = out.plan.components.find((c) => c.name === "a");
    const b = out.plan.components.find((c) => c.name === "b");

    expect(a?.status).toBe("done");
    expect(b?.status).toBe("upgrade");
    expect(b?.reference?.note).toBe("better one from the other site");
    expect(b?.verified?.against).toBe("reference");
    expect(new Set(out.carried)).toEqual(new Set(["a", "b"]));
    // Untouched rows stay pending.
    expect(out.plan.components.find((c) => c.name === "c")?.status).toBe("pending");
  });

  it("never downgrades a fresh row using a previous `pending`", () => {
    const previous = fresh(["a"]);
    const f = fresh(["a"]);
    setComponentStatus(f, "a", "done");

    const out = mergePlanDecisions(f, previous);
    expect(out.plan.components[0]?.status).toBe("done");
    expect(out.carried).toEqual([]);
  });

  it("reports decisions whose component vanished from the capture instead of dropping them silently", () => {
    const previous = fresh(["a", "gone", "also-gone"]);
    setComponentStatus(previous, "gone", "as-is");
    // `also-gone` was never decided, so its disappearance is not worth reporting.

    const out = mergePlanDecisions(fresh(["a"]), previous);
    expect(out.droppedWithDecisions).toEqual(["gone"]);
    expect(out.plan.components.map((c) => c.name)).toEqual(["a"]);
  });

  it("carries page readiness across a re-capture", () => {
    const previous = fresh(["a"]);
    setPageStatus(previous, "/p", "code");

    const out = mergePlanDecisions(fresh(["a"]), previous);
    expect(out.plan.pages[0]?.status).toBe("code");
  });

  it("lets the fresh capture own the row set, so new components arrive pending", () => {
    const previous = fresh(["a"]);
    setComponentStatus(previous, "a", "done");

    const out = mergePlanDecisions(fresh(["a", "brand-new"]), previous);
    expect(out.plan.components.map((c) => c.name).sort()).toEqual(["a", "brand-new"]);
    expect(out.plan.components.find((c) => c.name === "brand-new")?.status).toBe("pending");
  });

  it("matches names case- and separator-insensitively, like the reconciler", () => {
    const previous = fresh(["product-shelf"]);
    setComponentStatus(previous, "product-shelf", "done");

    const f = planWith(["product-shelf"]);
    const row = f.components[0];
    if (row) row.name = "ProductShelf";

    const out = mergePlanDecisions(f, previous);
    expect(out.plan.components[0]?.status).toBe("done");
  });
});

describe("pageColumn — raia derivada", () => {
  function columnOf(names: string[], mutate?: (p: MigrationPlan) => void): string {
    const plan = planWith(names);
    mutate?.(plan);
    return pageColumn(pagePlan(plan, "/p")!);
  }

  it("backlog quando nada começou", () => {
    expect(columnOf(["a", "b"])).toBe("backlog");
  });

  it("building quando algum componente já andou", () => {
    expect(
      columnOf(["a", "b"], (p) => {
        setComponentStatus(p, "a", "done");
      }),
    ).toBe("building");
  });

  it("review quando não sobra build nem validate, mas a página não foi fechada", () => {
    expect(
      columnOf(["a"], (p) => {
        setComponentStatus(p, "a", "done");
        setComponentVerified(p, "a", "pass", "2026-08-21T00:00:00.000Z");
      }),
    ).toBe("review");
  });

  it("done e skipped vêm do status explícito da página", () => {
    expect(columnOf(["a"], (p) => void setPageStatus(p, "/p", "done"))).toBe("done");
    expect(columnOf(["a"], (p) => void setPageStatus(p, "/p", "skipped"))).toBe("skipped");
  });

  it("triage quando o plano não tem aresta (plano antigo)", () => {
    const plan = planWith(["a"]);
    for (const page of plan.pages) page.components = undefined;
    expect(pageColumn(pagePlan(plan, "/p")!)).toBe("triage");
  });

  it("triage quando a captura não viu componente nenhum — não é 'pronto'", () => {
    const plan = planWith(["a"]);
    for (const page of plan.pages) page.components = [];
    expect(pageColumn(pagePlan(plan, "/p")!)).toBe("triage");
  });
});

describe("planBoard", () => {
  it("agrupa páginas por raia e lista o que bloqueia cada uma", () => {
    const header = live("header", "global");
    const shelf = live("product-shelf", "page");
    const hero = live("hero", "page");
    const plan = buildMigrationPlan({
      bundle: bundleOf(
        [header, shelf, hero],
        [
          { path: "/", kind: "home", components: [header, hero] },
          { path: "/p", kind: "pdp", components: [header, shelf] },
        ],
      ),
      source: { kind: "vtex-io", label: "VTEX IO", dir: null },
      inventory: inv([]),
    });

    const board = planBoard(plan);
    expect(board.sampled).toBe(2);
    expect(board.columns.backlog.map((c) => c.path).sort()).toEqual(["/", "/p"]);

    // Globais não poluem cada card — saem uma vez em `shell`.
    expect(board.shell).toEqual(["header"]);
    const pdp = board.columns.backlog.find((c) => c.path === "/p")!;
    expect(pdp.blockers).toEqual(["product-shelf"]);
    expect(pdp.blockers).not.toContain("header");
  });

  it("lista em `unassigned` o componente do código que nenhuma página amostrada usa", () => {
    const seen = live("hero", "page");
    const plan = buildMigrationPlan({
      bundle: bundleOf([seen], [{ path: "/", kind: "home", components: [seen] }]),
      source: { kind: "deco-fresh", label: "Deco/Fresh", dir: "/repo" },
      inventory: inv([src("OrphanSection", "section", "page")]),
    });

    const board = planBoard(plan);
    expect(board.unassigned).toContain("OrphanSection");
    expect(board.unassigned).not.toContain("hero");
  });
});
