import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffScreenshots } from "../../src/diff/visual.ts";
import { makeTmpDir } from "../helpers/tmp-dir.ts";

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

describe("diffScreenshots", () => {
  let dir: { path: string; cleanup: () => void };
  beforeEach(() => (dir = makeTmpDir()));
  afterEach(() => dir.cleanup());

  it("returns 0 diff for identical PNGs", () => {
    const a = join(dir.path, "a.png");
    const b = join(dir.path, "b.png");
    const heat = join(dir.path, "h.png");
    makePng(a, 50, 50, [100, 100, 100]);
    makePng(b, 50, 50, [100, 100, 100]);
    const r = diffScreenshots(a, b, heat);
    expect(r.diffPixels).toBe(0);
    expect(r.pctDiff).toBe(0);
    expect(r.passed).toBe(true);
    expect(existsSync(heat)).toBe(true);
  });

  it("returns ~100% diff for completely different PNGs", () => {
    const a = join(dir.path, "a.png");
    const b = join(dir.path, "b.png");
    makePng(a, 50, 50, [0, 0, 0]);
    makePng(b, 50, 50, [255, 255, 255]);
    const r = diffScreenshots(a, b, join(dir.path, "h.png"));
    expect(r.pctDiff).toBeGreaterThan(0.9);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/visual diff/);
  });

  it("crops to intersection when dimensions differ", () => {
    const a = join(dir.path, "a.png");
    const b = join(dir.path, "b.png");
    makePng(a, 50, 60, [10, 10, 10]);
    makePng(b, 50, 50, [10, 10, 10]);
    const r = diffScreenshots(a, b, join(dir.path, "h.png"));
    expect(r.width).toBe(50);
    expect(r.height).toBe(50);
    expect(r.diffPixels).toBe(0);
  });

  it("writes heatmap PNG of the same intersection size", () => {
    const a = join(dir.path, "a.png");
    const b = join(dir.path, "b.png");
    const heat = join(dir.path, "h.png");
    makePng(a, 30, 30, [0, 0, 0]);
    makePng(b, 30, 30, [255, 255, 255]);
    diffScreenshots(a, b, heat);
    const written = PNG.sync.read(readFileSync(heat));
    expect(written.width).toBe(30);
    expect(written.height).toBe(30);
  });

  it("respects maxPctDiff option", () => {
    const a = join(dir.path, "a.png");
    const b = join(dir.path, "b.png");
    makePng(a, 50, 50, [0, 0, 0]);
    makePng(b, 50, 50, [255, 255, 255]);
    const lenient = diffScreenshots(a, b, join(dir.path, "h1.png"), { maxPctDiff: 1.0 });
    expect(lenient.passed).toBe(true);
    const strict = diffScreenshots(a, b, join(dir.path, "h2.png"), { maxPctDiff: 0.001 });
    expect(strict.passed).toBe(false);
  });
});
