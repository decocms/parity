import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  baselinePath,
  compareToBaseline,
  deleteBaseline,
  listBaselines,
  loadBaseline,
  saveBaseline,
} from "../../src/storage/baselines.ts";
import type { Run } from "../../src/types/schema.ts";
import { makeIssue, makeRun } from "../helpers/make-run.ts";
import { makeTmpDir } from "../helpers/tmp-dir.ts";

describe("baselinePath", () => {
  it("validates safe baseline names", () => {
    expect(baselinePath("stable", "/tmp")).toBe("/tmp/stable.json");
    expect(baselinePath("my-baseline_2", "/tmp")).toBe("/tmp/my-baseline_2.json");
  });

  it("rejects unsafe names", () => {
    expect(() => baselinePath("../escape", "/tmp")).toThrow(/Invalid baseline name/);
    expect(() => baselinePath("with space", "/tmp")).toThrow();
    expect(() => baselinePath("with.dot", "/tmp")).toThrow();
  });
});

describe("saveBaseline / loadBaseline", () => {
  let dir: { path: string; cleanup: () => void };
  beforeEach(() => (dir = makeTmpDir()));
  afterEach(() => dir.cleanup());

  it("roundtrips a baseline through disk", () => {
    const run = makeRun({ id: "x", issues: [makeIssue({ id: "i1" })] });
    const path = saveBaseline("stable", run, dir.path);
    expect(existsSync(path)).toBe(true);
    const loaded = loadBaseline("stable", dir.path);
    expect(loaded.name).toBe("stable");
    expect(loaded.fromRunId).toBe("x");
    expect(loaded.issues[0]?.id).toBe("i1");
  });

  it("creates the baseline directory if missing", () => {
    saveBaseline("auto", makeRun(), `${dir.path}/sub/dir`);
    expect(existsSync(`${dir.path}/sub/dir/auto.json`)).toBe(true);
  });

  it("loadBaseline throws when missing", () => {
    expect(() => loadBaseline("nope", dir.path)).toThrow(/Baseline not found/);
  });
});

describe("listBaselines", () => {
  let dir: { path: string; cleanup: () => void };
  beforeEach(() => (dir = makeTmpDir()));
  afterEach(() => dir.cleanup());

  it("returns [] when dir is missing", () => {
    expect(listBaselines(`${dir.path}/nope`)).toEqual([]);
  });

  it("lists baselines sorted alphabetically by name", () => {
    saveBaseline("zeta", makeRun(), dir.path);
    saveBaseline("alpha", makeRun(), dir.path);
    saveBaseline("middle", makeRun(), dir.path);
    expect(listBaselines(dir.path).map((b) => b.name)).toEqual(["alpha", "middle", "zeta"]);
  });
});

describe("deleteBaseline", () => {
  let dir: { path: string; cleanup: () => void };
  beforeEach(() => (dir = makeTmpDir()));
  afterEach(() => dir.cleanup());

  it("removes a baseline file", () => {
    const path = saveBaseline("rm", makeRun(), dir.path);
    expect(existsSync(path)).toBe(true);
    deleteBaseline("rm", dir.path);
    expect(existsSync(path)).toBe(false);
  });

  it("is a no-op when baseline missing", () => {
    expect(() => deleteBaseline("nope", dir.path)).not.toThrow();
  });
});

describe("compareToBaseline", () => {
  it("identifies resolved (in base, not in current)", () => {
    const baseline = { issues: [makeIssue({ id: "old" })] } as ReturnType<
      typeof makeRun
    > as unknown as {
      issues: typeof makeIssue extends () => infer T ? T[] : never;
    };
    const current: Run = makeRun({ issues: [makeIssue({ id: "new" })] });
    const delta = compareToBaseline(current, {
      name: "x",
      createdAt: "",
      fromRunId: "",
      prodUrl: "",
      candUrl: "",
      verdict: current.verdict,
      issues: baseline.issues as never,
    });
    expect(delta.resolved).toEqual(["old"]);
    expect(delta.new).toEqual(["new"]);
  });

  it("identifies regressions (same id, worse severity)", () => {
    const current: Run = makeRun({
      issues: [makeIssue({ id: "x", severity: "critical" })],
    });
    const delta = compareToBaseline(current, {
      name: "x",
      createdAt: "",
      fromRunId: "",
      prodUrl: "",
      candUrl: "",
      verdict: current.verdict,
      issues: [makeIssue({ id: "x", severity: "low" })],
    });
    expect(delta.regressions).toEqual(["x"]);
  });

  it("does NOT flag same-severity issues as regressions", () => {
    const current: Run = makeRun({
      issues: [makeIssue({ id: "x", severity: "high" })],
    });
    const delta = compareToBaseline(current, {
      name: "x",
      createdAt: "",
      fromRunId: "",
      prodUrl: "",
      candUrl: "",
      verdict: current.verdict,
      issues: [makeIssue({ id: "x", severity: "high" })],
    });
    expect(delta.regressions).toEqual([]);
  });
});
