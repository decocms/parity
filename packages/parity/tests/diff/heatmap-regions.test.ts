import { describe, expect, it } from "vitest";
import { analyzeHeatmapBuffer } from "../../src/diff/heatmap-regions.ts";

/**
 * Build a synthetic RGBA pixel buffer for testing. Background is gray
 * (mimicking pixelmatch's desaturated copy of the prod image); diff
 * regions are painted red so the same code path as production input
 * runs.
 */
function makeBuffer(
  width: number,
  height: number,
  paint: (x: number, y: number) => "red" | "gray",
): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = paint(x, y);
      if (c === "red") {
        buf[i] = 255;
        buf[i + 1] = 0;
        buf[i + 2] = 0;
        buf[i + 3] = 255;
      } else {
        buf[i] = 128;
        buf[i + 1] = 128;
        buf[i + 2] = 128;
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

describe("analyzeHeatmapBuffer", () => {
  it("retorna zero diff quando não há pixel vermelho", () => {
    const buf = makeBuffer(50, 50, () => "gray");
    const r = analyzeHeatmapBuffer(buf, 50, 50);
    expect(r.diffPixels).toBe(0);
    expect(r.pctDiff).toBe(0);
    expect(r.boundingBox).toBeNull();
    expect(r.hotspots).toEqual([]);
  });

  it("detecta um cluster retangular único", () => {
    // 100x100 image, 20x10 red block at (30, 40)
    const buf = makeBuffer(100, 100, (x, y) => {
      const inBlock = x >= 30 && x < 50 && y >= 40 && y < 50;
      return inBlock ? "red" : "gray";
    });
    const r = analyzeHeatmapBuffer(buf, 100, 100);
    expect(r.diffPixels).toBe(200);
    expect(r.boundingBox).toEqual({ x: 30, y: 40, width: 20, height: 10, pixelCount: 200 });
    expect(r.hotspots).toHaveLength(1);
    expect(r.hotspots[0]?.width).toBe(20);
    expect(r.hotspots[0]?.height).toBe(10);
  });

  it("separa dois clusters não conectados em hotspots distintos", () => {
    // Two 10x10 red blocks, separated by gray
    const buf = makeBuffer(100, 100, (x, y) => {
      const inA = x >= 10 && x < 20 && y >= 10 && y < 20;
      const inB = x >= 60 && x < 70 && y >= 60 && y < 70;
      return inA || inB ? "red" : "gray";
    });
    const r = analyzeHeatmapBuffer(buf, 100, 100);
    expect(r.hotspots).toHaveLength(2);
    // Global bbox covers both
    expect(r.boundingBox).toEqual({
      x: 10,
      y: 10,
      width: 60,
      height: 60,
      pixelCount: 200,
    });
  });

  it("descarta componentes abaixo de minComponentPixels (anti-noise)", () => {
    // One large block (100 px) + one 4-pixel speck (below threshold).
    const buf = makeBuffer(100, 100, (x, y) => {
      const inBlock = x >= 10 && x < 20 && y >= 10 && y < 20; // 100 px
      const inSpeck = x >= 80 && x < 82 && y >= 80 && y < 82; // 4 px
      return inBlock || inSpeck ? "red" : "gray";
    });
    const r = analyzeHeatmapBuffer(buf, 100, 100, { minComponentPixels: 50 });
    expect(r.hotspots).toHaveLength(1);
    // But global bbox STILL includes the speck — diffPixels counts everything.
    expect(r.diffPixels).toBe(104);
  });

  it("ordena hotspots por área desc", () => {
    const buf = makeBuffer(200, 200, (x, y) => {
      const bigBlock = x >= 10 && x < 60 && y >= 10 && y < 60; // 50×50 = 2500
      const smallBlock = x >= 100 && x < 120 && y >= 100 && y < 120; // 20×20 = 400
      return bigBlock || smallBlock ? "red" : "gray";
    });
    const r = analyzeHeatmapBuffer(buf, 200, 200);
    expect(r.hotspots.length).toBeGreaterThanOrEqual(2);
    expect(r.hotspots[0]!.width * r.hotspots[0]!.height).toBeGreaterThan(
      r.hotspots[1]!.width * r.hotspots[1]!.height,
    );
  });

  it("limita ao máximo de hotspots pedido", () => {
    // Create 8 separate blocks
    const buf = makeBuffer(200, 200, (x, y) => {
      for (let i = 0; i < 8; i++) {
        const bx = (i % 4) * 50;
        const by = Math.floor(i / 4) * 100;
        if (x >= bx && x < bx + 20 && y >= by && y < by + 20) return "red";
      }
      return "gray";
    });
    const r = analyzeHeatmapBuffer(buf, 200, 200, { maxHotspots: 3 });
    expect(r.hotspots).toHaveLength(3);
  });

  it("trata 8-connectivity: clusters em diagonal são UM componente", () => {
    // 3 red pixels forming a diagonal line — should be one component under 8-connectivity.
    const buf = makeBuffer(10, 10, (x, y) => {
      if ((x === 1 && y === 1) || (x === 2 && y === 2) || (x === 3 && y === 3)) return "red";
      return "gray";
    });
    const r = analyzeHeatmapBuffer(buf, 10, 10, { minComponentPixels: 1 });
    expect(r.hotspots).toHaveLength(1);
    expect(r.hotspots[0]!.pixelCount).toBe(3);
  });

  it("computa pctDiff corretamente", () => {
    const buf = makeBuffer(10, 10, (x, y) => (x < 5 && y < 5 ? "red" : "gray"));
    const r = analyzeHeatmapBuffer(buf, 10, 10, { minComponentPixels: 1 });
    expect(r.diffPixels).toBe(25);
    expect(r.pctDiff).toBe(0.25);
  });
});
