import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planSetStatusCommand } from "../../src/commands/plan.ts";
import { type MigrationPlan, loadPlan, savePlan } from "../../src/migrate/plan.ts";

function planWith(): MigrationPlan {
  return {
    url: "https://shop.example",
    timestamp: "2026-08-19T00:00:00.000Z",
    source: { kind: "deco-fresh", label: "Deco/Fresh", dir: "/repo", notes: [] },
    target: { name: "faststore" },
    pages: [{ path: "/", kind: "home" }],
    components: [
      {
        name: "ProductShelf",
        role: "shelf",
        scope: "page",
        origin: "both",
        status: "pending",
        file: null,
      },
    ],
  };
}

describe("parity plan set-status", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parity-plan-cmd-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("flips status and persists (case/separator-insensitive match)", () => {
    savePlan(dir, planWith());
    // "product-shelf" must match "ProductShelf".
    expect(planSetStatusCommand(dir, "product-shelf", "done")).toBe(0);
    expect(loadPlan(dir)?.components[0]?.status).toBe("done");
  });

  it("rejects an invalid status without touching the file", () => {
    savePlan(dir, planWith());
    expect(planSetStatusCommand(dir, "ProductShelf", "porting")).toBe(1);
    expect(loadPlan(dir)?.components[0]?.status).toBe("pending");
  });

  it("errors when the component is not found", () => {
    savePlan(dir, planWith());
    expect(planSetStatusCommand(dir, "Nonexistent", "done")).toBe(1);
  });

  it("errors when no plan exists in the dir", () => {
    expect(planSetStatusCommand(dir, "ProductShelf", "done")).toBe(1);
  });
});
