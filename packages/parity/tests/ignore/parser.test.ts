import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadParityIgnore, loadParityRc } from "../../src/ignore/parser.ts";
import { makeTmpDir } from "../helpers/tmp-dir.ts";

describe("loadParityRc", () => {
  let dir: { path: string; cleanup: () => void };

  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => dir.cleanup());

  it("returns defaults when .parityrc.json is absent", () => {
    const rc = loadParityRc(dir.path);
    expect(rc.cep).toBe("01310-100");
    expect(rc.selectors).toEqual({});
    expect(rc.skipSteps).toEqual([]);
  });

  it("loads valid JSON and overrides defaults", () => {
    writeFileSync(
      join(dir.path, ".parityrc.json"),
      JSON.stringify({ cep: "12345-678", selectors: { buyButton: "#buy" } }),
    );
    const rc = loadParityRc(dir.path);
    expect(rc.cep).toBe("12345-678");
    expect(rc.selectors.buyButton).toBe("#buy");
  });

  it("logs warning and returns defaults on invalid JSON", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(join(dir.path, ".parityrc.json"), "{not valid json");
    const rc = loadParityRc(dir.path);
    expect(rc.cep).toBe("01310-100");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("failed to parse"));
    spy.mockRestore();
  });

  it("logs warning and returns defaults on schema mismatch", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(join(dir.path, ".parityrc.json"), JSON.stringify({ cep: 12345 })); // cep must be string
    const rc = loadParityRc(dir.path);
    expect(rc.cep).toBe("01310-100");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("loadParityIgnore", () => {
  let dir: { path: string; cleanup: () => void };

  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => dir.cleanup());

  it("returns defaults when .parityignore is absent", () => {
    const ig = loadParityIgnore(dir.path);
    expect(ig.ignoreSelectorsVisual).toEqual([]);
    expect(ig.ignoreRequestPatterns).toEqual([]);
  });

  it("loads valid JSON", () => {
    writeFileSync(
      join(dir.path, ".parityignore"),
      JSON.stringify({ ignoreSelectorsVisual: [".banner"], ignoreConsolePatterns: ["ERR_X"] }),
    );
    const ig = loadParityIgnore(dir.path);
    expect(ig.ignoreSelectorsVisual).toEqual([".banner"]);
    expect(ig.ignoreConsolePatterns).toEqual(["ERR_X"]);
  });

  it("logs warning and returns defaults on invalid JSON", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    writeFileSync(join(dir.path, ".parityignore"), "not json at all");
    const ig = loadParityIgnore(dir.path);
    expect(ig.ignoreSelectorsVisual).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
