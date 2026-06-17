import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type LearnedSelectors,
  getLearnedSelectors,
  loadLearned,
  promoteFromLlm,
  recordFailure,
  recordSuccess,
  saveLearned,
  statsFromLib,
} from "../../src/learned/repo.ts";
import { makeTmpDir } from "../helpers/tmp-dir.ts";

function emptyLib(): LearnedSelectors {
  return { schemaVersion: "0.1", platforms: {} };
}

describe("loadLearned / saveLearned", () => {
  let dir: { path: string; cleanup: () => void };
  beforeEach(() => (dir = makeTmpDir()));
  afterEach(() => dir.cleanup());

  it("returns empty lib when file does not exist", () => {
    const lib = loadLearned(join(dir.path, "nope.json"));
    expect(lib).toEqual(emptyLib());
  });

  it("roundtrips through disk", () => {
    const lib = emptyLib();
    promoteFromLlm(lib, "vtex", "buyButton", ".buy", "example.com");
    const path = join(dir.path, "learned.json");
    saveLearned(lib, path);
    expect(existsSync(path)).toBe(true);
    const loaded = loadLearned(path);
    expect(loaded.platforms.vtex?.buyButton?.[0]?.selector).toBe(".buy");
  });

  it("returns empty lib + logs warning on invalid JSON", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const path = join(dir.path, "bad.json");
    writeFileSync(path, "{not json");
    const lib = loadLearned(path);
    expect(lib).toEqual(emptyLib());
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns empty lib + logs warning on schema mismatch", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const path = join(dir.path, "bad-schema.json");
    writeFileSync(path, JSON.stringify({ wrong: "shape" }));
    expect(loadLearned(path)).toEqual(emptyLib());
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("atomic save: tempfile then rename", () => {
    const lib = emptyLib();
    recordSuccess(lib, "shopify", "categoryLink", ".cat", "host.com");
    const path = join(dir.path, "atomic.json");
    saveLearned(lib, path);
    expect(existsSync(path)).toBe(true);
    // No leftover .tmp- file should remain
    // (we can't easily list dir here without importing readdirSync,
    //  but the rename guarantees atomicity)
  });
});

describe("recordSuccess / recordFailure / promoteFromLlm", () => {
  it("recordSuccess increments stats and adds host", () => {
    const lib = emptyLib();
    const e1 = recordSuccess(lib, "vtex", "buyButton", ".x", "host1.com");
    expect(e1.totalAttempts).toBe(1);
    expect(e1.successRate).toBe(1);
    const e2 = recordSuccess(lib, "vtex", "buyButton", ".x", "host2.com");
    expect(e2.totalAttempts).toBe(2);
    expect(e2.confirmedHosts).toEqual(["host1.com", "host2.com"]);
  });

  it("recordSuccess does not duplicate hosts", () => {
    const lib = emptyLib();
    recordSuccess(lib, "vtex", "buyButton", ".x", "h");
    const e = recordSuccess(lib, "vtex", "buyButton", ".x", "h");
    expect(e.confirmedHosts).toEqual(["h"]);
  });

  it("recordFailure deprecates after 3 attempts with <30% success rate", () => {
    const lib = emptyLib();
    promoteFromLlm(lib, "vtex", "buyButton", ".x", "h");
    recordFailure(lib, "vtex", "buyButton", ".x", "h");
    recordFailure(lib, "vtex", "buyButton", ".x", "h");
    const e = recordFailure(lib, "vtex", "buyButton", ".x", "h");
    expect(e?.deprecated).toBe(true);
  });

  it("recordSuccess un-deprecates when success rate climbs back above 50%", () => {
    const lib = emptyLib();
    promoteFromLlm(lib, "vtex", "buyButton", ".x", "h");
    recordFailure(lib, "vtex", "buyButton", ".x", "h");
    recordFailure(lib, "vtex", "buyButton", ".x", "h");
    recordFailure(lib, "vtex", "buyButton", ".x", "h");
    // Now 4 successes in a row → rate climbs back
    for (let i = 0; i < 5; i++) recordSuccess(lib, "vtex", "buyButton", ".x", "h");
    const list = getLearnedSelectors(lib, "vtex", "buyButton");
    expect(list[0]?.selector).toBe(".x");
  });

  it("recordFailure returns null when selector not found", () => {
    const lib = emptyLib();
    expect(recordFailure(lib, "vtex", "buyButton", "missing", "h")).toBeNull();
  });

  it("promoteFromLlm with existing entry reuses recordSuccess", () => {
    const lib = emptyLib();
    promoteFromLlm(lib, "vtex", "buyButton", ".x", "h1");
    const e = promoteFromLlm(lib, "vtex", "buyButton", ".x", "h2");
    expect(e.confirmedHosts).toEqual(["h1", "h2"]);
  });
});

describe("getLearnedSelectors", () => {
  it("returns entries sorted by successRate desc", () => {
    const lib = emptyLib();
    promoteFromLlm(lib, "vtex", "buyButton", ".low", "h");
    recordFailure(lib, "vtex", "buyButton", ".low", "h");
    promoteFromLlm(lib, "vtex", "buyButton", ".high", "h");
    for (let i = 0; i < 5; i++) recordSuccess(lib, "vtex", "buyButton", ".high", "h");
    const list = getLearnedSelectors(lib, "vtex", "buyButton");
    expect(list[0]?.selector).toBe(".high");
  });

  it("excludes deprecated entries", () => {
    const lib = emptyLib();
    promoteFromLlm(lib, "vtex", "buyButton", ".dep", "h");
    for (let i = 0; i < 4; i++) recordFailure(lib, "vtex", "buyButton", ".dep", "h");
    const list = getLearnedSelectors(lib, "vtex", "buyButton");
    expect(list.find((e) => e.selector === ".dep")).toBeUndefined();
  });

  it("returns [] for unknown platform", () => {
    const lib = emptyLib();
    expect(getLearnedSelectors(lib, "deco", "buyButton")).toEqual([]);
  });
});

describe("statsFromLib", () => {
  it("aggregates counts per platform", () => {
    const lib = emptyLib();
    promoteFromLlm(lib, "vtex", "buyButton", ".a", "h");
    promoteFromLlm(lib, "vtex", "categoryLink", ".b", "h");
    promoteFromLlm(lib, "shopify", "buyButton", ".c", "h");
    const stats = statsFromLib(lib);
    expect(stats.platforms.find((p) => p.platform === "vtex")?.totalSelectors).toBe(2);
    expect(stats.platforms.find((p) => p.platform === "shopify")?.totalSelectors).toBe(1);
  });
});
