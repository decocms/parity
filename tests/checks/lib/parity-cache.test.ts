import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getCacheEntry,
  hashScreenshotPair,
  readCache,
  setCacheEntry,
  writeCache,
} from "../../../src/checks/lib/parity-cache.ts";
import { makeTmpDir } from "../../helpers/tmp-dir.ts";

function makePng(path: string, w: number, h: number, fill: [number, number, number]): void {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (w * y + x) << 2;
      png.data[idx] = fill[0];
      png.data[idx + 1] = fill[1];
      png.data[idx + 2] = fill[2];
      png.data[idx + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
}

describe("parity-cache", () => {
  let dir: { path: string; cleanup: () => void };

  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    dir.cleanup();
  });

  describe("hashScreenshotPair", () => {
    it("produces stable hash for identical inputs", () => {
      const prod = join(dir.path, "p.png");
      const cand = join(dir.path, "c.png");
      makePng(prod, 10, 10, [100, 100, 100]);
      makePng(cand, 10, 10, [120, 120, 120]);
      const a = hashScreenshotPair(prod, cand, "v1");
      const b = hashScreenshotPair(prod, cand, "v1");
      expect(a).toBe(b);
      expect(a).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
    });

    it("changes hash when prod screenshot changes", () => {
      const prod = join(dir.path, "p.png");
      const cand = join(dir.path, "c.png");
      makePng(prod, 10, 10, [100, 100, 100]);
      makePng(cand, 10, 10, [120, 120, 120]);
      const a = hashScreenshotPair(prod, cand, "v1");
      makePng(prod, 10, 10, [200, 200, 200]); // overwrite
      const b = hashScreenshotPair(prod, cand, "v1");
      expect(a).not.toBe(b);
    });

    it("changes hash when prompt version changes (cache invalidation)", () => {
      const prod = join(dir.path, "p.png");
      const cand = join(dir.path, "c.png");
      makePng(prod, 10, 10, [100, 100, 100]);
      makePng(cand, 10, 10, [120, 120, 120]);
      const a = hashScreenshotPair(prod, cand, "v1");
      const b = hashScreenshotPair(prod, cand, "v2");
      expect(a).not.toBe(b);
    });
  });

  describe("read / write / lookup", () => {
    it("readCache returns empty object when file does not exist", () => {
      expect(readCache(dir.path)).toEqual({});
    });

    it("writeCache + readCache round-trips entries", () => {
      const cache = {};
      setCacheEntry(cache, "deadbeef", {
        verdict: "pass",
        differences: [],
        sectionsOnlyInProd: [],
        sectionsOnlyInCand: [],
        pctDiff: 0.42,
        llmPromptVersion: "v1",
        cachedAt: "2026-05-29T00:00:00Z",
      });
      writeCache(dir.path, cache);
      expect(existsSync(join(dir.path, "verdicts.json"))).toBe(true);
      const reread = readCache(dir.path);
      expect(reread.deadbeef?.verdict).toBe("pass");
      expect(reread.deadbeef?.pctDiff).toBe(0.42);
    });

    it("getCacheEntry returns entry when prompt version matches", () => {
      const cache = {
        abc: {
          verdict: "pass" as const,
          differences: [],
          sectionsOnlyInProd: [],
          sectionsOnlyInCand: [],
          pctDiff: 0.1,
          llmPromptVersion: "v1",
          cachedAt: "2026-01-01T00:00:00Z",
        },
      };
      expect(getCacheEntry(cache, "abc", "v1")?.verdict).toBe("pass");
    });

    it("getCacheEntry treats prompt-version mismatch as cache miss", () => {
      const cache = {
        abc: {
          verdict: "pass" as const,
          differences: [],
          sectionsOnlyInProd: [],
          sectionsOnlyInCand: [],
          pctDiff: 0.1,
          llmPromptVersion: "v1",
          cachedAt: "2026-01-01T00:00:00Z",
        },
      };
      expect(getCacheEntry(cache, "abc", "v2")).toBeUndefined();
    });

    it("readCache survives corrupt JSON (returns empty)", () => {
      writeFileSync(join(dir.path, "verdicts.json"), "{not json");
      expect(readCache(dir.path)).toEqual({});
    });
  });
});
