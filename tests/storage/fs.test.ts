import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRunDir,
  getRunPaths,
  listRuns,
  loadRun,
  newRunId,
  writeRunReportHtml,
  writeRunReportJson,
} from "../../src/storage/fs.ts";
import { makeRun } from "../helpers/make-run.ts";
import { makeTmpDir } from "../helpers/tmp-dir.ts";

describe("newRunId", () => {
  it("returns an ISO-like timestamp string", () => {
    const id = newRunId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it("is monotonically unique over time", async () => {
    const a = newRunId();
    await new Promise((r) => setTimeout(r, 5));
    const b = newRunId();
    expect(b > a).toBe(true);
  });
});

describe("createRunDir + getRunPaths", () => {
  let dir: { path: string; cleanup: () => void };
  beforeEach(() => (dir = makeTmpDir()));
  afterEach(() => dir.cleanup());

  it("creates all subdirectories", () => {
    const p = createRunDir(dir.path, "run-1");
    expect(existsSync(p.runDir)).toBe(true);
    expect(existsSync(p.screenshotsDir)).toBe(true);
    expect(existsSync(p.harDir)).toBe(true);
    expect(existsSync(p.tracesDir)).toBe(true);
    expect(existsSync(p.consoleDir)).toBe(true);
  });

  it("getRunPaths returns same paths without creating", () => {
    const p = getRunPaths(dir.path, "run-2");
    expect(p.reportJson).toBe(join(dir.path, "runs", "run-2", "report.json"));
    expect(existsSync(p.runDir)).toBe(false);
  });
});

describe("writeRunReportJson / writeRunReportHtml + loadRun", () => {
  let dir: { path: string; cleanup: () => void };
  beforeEach(() => (dir = makeTmpDir()));
  afterEach(() => dir.cleanup());

  it("writes report.json and report.html", () => {
    const p = createRunDir(dir.path, "run-w");
    const run = makeRun({ id: "run-w" });
    const jsonPath = writeRunReportJson(p.runDir, run);
    const htmlPath = writeRunReportHtml(p.runDir, "<html>x</html>");
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(htmlPath)).toBe(true);
    expect(readFileSync(htmlPath, "utf8")).toBe("<html>x</html>");
  });

  it("loadRun roundtrips a written run through Zod", () => {
    const p = createRunDir(dir.path, "run-rt");
    const run = makeRun({ id: "run-rt" });
    writeRunReportJson(p.runDir, run);
    const loaded = loadRun(dir.path, "run-rt");
    expect(loaded.id).toBe("run-rt");
  });

  it("loadRun throws when run is missing", () => {
    expect(() => loadRun(dir.path, "nope")).toThrow(/Run not found/);
  });

  it("loadRun throws when JSON does not match schema", () => {
    const p = createRunDir(dir.path, "bad");
    writeFileSync(p.reportJson, JSON.stringify({ not: "a run" }));
    expect(() => loadRun(dir.path, "bad")).toThrow();
  });
});

describe("listRuns", () => {
  let dir: { path: string; cleanup: () => void };
  beforeEach(() => (dir = makeTmpDir()));
  afterEach(() => dir.cleanup());

  it("returns [] when runs directory does not exist", () => {
    expect(listRuns(dir.path)).toEqual([]);
  });

  it("lists runs sorted desc by id (newest first)", () => {
    const a = createRunDir(dir.path, "2026-01-01");
    writeRunReportJson(a.runDir, makeRun({ id: "2026-01-01" }));
    const b = createRunDir(dir.path, "2026-02-01");
    writeRunReportJson(b.runDir, makeRun({ id: "2026-02-01" }));
    const list = listRuns(dir.path);
    expect(list.map((r) => r.id)).toEqual(["2026-02-01", "2026-01-01"]);
  });

  it("falls back to run id when report.json cannot be read", () => {
    createRunDir(dir.path, "broken");
    const list = listRuns(dir.path);
    expect(list[0]?.id).toBe("broken");
    expect(list[0]?.timestamp).toBe("broken"); // fallback
  });
});
