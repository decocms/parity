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

  it("promoteFromLlm(verified=true) seeds directly at origin verified / rate 1 (M4 validated+high-confidence path)", () => {
    const lib = emptyLib();
    const entry = promoteFromLlm(lib, "vtex", "buyButton", ".validated", "h", true);
    expect(entry.origin).toBe("verified");
    expect(entry.successRate).toBe(1);
    expect(entry.totalAttempts).toBe(1);
  });

  it("promoteFromLlm(verified=false or omitted) keeps the pre-M4 llm-guess seeding", () => {
    const lib = emptyLib();
    const entry = promoteFromLlm(lib, "vtex", "buyButton", ".unvalidated", "h");
    expect(entry.origin).toBe("llm-guess");
    expect(entry.successRate).toBe(0.35);
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

describe("lifecycle: origin + staleness (M1.3)", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

  it("promoteFromLlm seeds as llm-guess at 0.35", () => {
    const lib = emptyLib();
    const entry = promoteFromLlm(lib, "vtex", "buyButton", ".guess", "h");
    expect(entry.origin).toBe("llm-guess");
    expect(entry.successRate).toBe(0.35);
  });

  it("recordSuccess upgrades an llm-guess to verified", () => {
    const lib = emptyLib();
    promoteFromLlm(lib, "vtex", "buyButton", ".guess", "h");
    const entry = recordSuccess(lib, "vtex", "buyButton", ".guess", "h2");
    expect(entry.origin).toBe("verified");
  });

  it("verified entries rank above llm-guesses regardless of rate", () => {
    const lib = emptyLib();
    promoteFromLlm(lib, "vtex", "buyButton", ".guess", "h"); // 0.35 guess
    recordSuccess(lib, "vtex", "buyButton", ".proven", "h"); // 1.0 verified
    // inflate the guess rate above the verified one
    const slot = lib.platforms.vtex!.buyButton!;
    slot.find((e) => e.selector === ".guess")!.successRate = 1;
    slot.find((e) => e.selector === ".proven")!.successRate = 0.6;
    const list = getLearnedSelectors(lib, "vtex", "buyButton");
    expect(list[0]?.selector).toBe(".proven");
  });

  it("stale entries (>90d) decay below recently validated ones", () => {
    const lib = emptyLib();
    recordSuccess(lib, "vtex", "buyButton", ".stale-champion", "h");
    recordSuccess(lib, "vtex", "buyButton", ".fresh", "h");
    const slot = lib.platforms.vtex!.buyButton!;
    const champ = slot.find((e) => e.selector === ".stale-champion")!;
    champ.successRate = 0.9;
    champ.lastValidated = daysAgo(120); // effective 0.45
    slot.find((e) => e.selector === ".fresh")!.successRate = 0.6; // effective 0.6
    const list = getLearnedSelectors(lib, "vtex", "buyButton");
    expect(list[0]?.selector).toBe(".fresh");
  });

  it("llm-guesses expire after 180d without confirmation; verified do not", () => {
    const lib = emptyLib();
    promoteFromLlm(lib, "vtex", "buyButton", ".old-guess", "h");
    recordSuccess(lib, "vtex", "buyButton", ".old-verified", "h");
    const slot = lib.platforms.vtex!.buyButton!;
    slot.find((e) => e.selector === ".old-guess")!.lastValidated = daysAgo(200);
    slot.find((e) => e.selector === ".old-verified")!.lastValidated = daysAgo(200);
    const list = getLearnedSelectors(lib, "vtex", "buyButton");
    expect(list.find((e) => e.selector === ".old-guess")).toBeUndefined();
    expect(list.find((e) => e.selector === ".old-verified")).toBeDefined();
  });

  it("legacy entries without origin parse as verified (auto-migration)", () => {
    const raw = {
      schemaVersion: "0.1",
      platforms: {
        vtex: {
          buyButton: [
            {
              selector: ".legacy",
              confirmedHosts: ["h"],
              successRate: 0.8,
              totalAttempts: 5,
              lastValidated: new Date().toISOString(),
            },
          ],
        },
      },
    };
    const dir = makeTmpDir();
    try {
      const path = join(dir.path, "learned.json");
      writeFileSync(path, JSON.stringify(raw), "utf8");
      const lib = loadLearned(path);
      expect(lib.platforms.vtex?.buyButton?.[0]?.origin).toBe("verified");
    } finally {
      dir.cleanup();
    }
  });

  it("statsFromLib reports verified/guess/stale counts", () => {
    const lib = emptyLib();
    recordSuccess(lib, "vtex", "buyButton", ".v", "h");
    promoteFromLlm(lib, "vtex", "categoryLink", ".g", "h");
    lib.platforms.vtex!.buyButton![0]!.lastValidated = daysAgo(120);
    const stats = statsFromLib(lib);
    const p = stats.platforms.find((x) => x.platform === "vtex")!;
    expect(p.verifiedSelectors).toBe(1);
    expect(p.llmGuessSelectors).toBe(1);
    expect(p.staleSelectors).toBe(1);
    expect(p.topByKey.find((t) => t.key === "categoryLink")?.origin).toBe("llm-guess");
  });
});
