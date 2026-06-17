import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { cropPngBuffer } from "../../src/engine/capture-utils.ts";

function makeSolidPng(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = rgba[0];
      png.data[i + 1] = rgba[1];
      png.data[i + 2] = rgba[2];
      png.data[i + 3] = rgba[3];
    }
  }
  return PNG.sync.write(png);
}

/** Build a 100×100 PNG that is red in the top-left 50×50 and blue elsewhere. */
function makeBicolorPng(): Buffer {
  const w = 100;
  const h = 100;
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inRed = x < 50 && y < 50;
      png.data[i] = inRed ? 255 : 0;
      png.data[i + 1] = 0;
      png.data[i + 2] = inRed ? 0 : 255;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("cropPngBuffer (issue #51 regression: full-page + crop preserves CSS context)", () => {
  it("retorna PNG do tamanho exato da boundingBox", () => {
    const src = makeSolidPng(200, 100, [10, 20, 30, 255]);
    const out = cropPngBuffer(src, { x: 10, y: 20, width: 50, height: 40 });
    const decoded = PNG.sync.read(out);
    expect(decoded.width).toBe(50);
    expect(decoded.height).toBe(40);
  });

  it("preserva os pixels da região cortada (top-left red de uma imagem bicolor)", () => {
    const src = makeBicolorPng();
    const out = cropPngBuffer(src, { x: 0, y: 0, width: 50, height: 50 });
    const decoded = PNG.sync.read(out);
    // Pixel central da região cortada deve ser vermelho (R=255, G=0, B=0).
    const i = (25 * decoded.width + 25) * 4;
    expect(decoded.data[i]).toBe(255);
    expect(decoded.data[i + 1]).toBe(0);
    expect(decoded.data[i + 2]).toBe(0);
  });

  it("pega a região azul quando boundingBox aponta pra fora do quadrante vermelho", () => {
    const src = makeBicolorPng();
    const out = cropPngBuffer(src, { x: 60, y: 60, width: 30, height: 30 });
    const decoded = PNG.sync.read(out);
    const i = (15 * decoded.width + 15) * 4;
    expect(decoded.data[i]).toBe(0);
    expect(decoded.data[i + 1]).toBe(0);
    expect(decoded.data[i + 2]).toBe(255);
  });

  it("clampa boundingBox que ultrapassa as bordas do source", () => {
    const src = makeSolidPng(100, 100, [0, 255, 0, 255]);
    // Box tenta cortar 50px começando em x=80 (faltam 30px no source).
    const out = cropPngBuffer(src, { x: 80, y: 80, width: 50, height: 50 });
    const decoded = PNG.sync.read(out);
    expect(decoded.width).toBe(20);
    expect(decoded.height).toBe(20);
  });

  it("aceita boundingBox com coordenadas fracionárias (Playwright às vezes retorna .5)", () => {
    const src = makeSolidPng(100, 100, [0, 0, 0, 255]);
    const out = cropPngBuffer(src, { x: 10.4, y: 10.6, width: 30.5, height: 30.5 });
    const decoded = PNG.sync.read(out);
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
  });

  it("lança quando a boundingBox tem área zero após o clamp", () => {
    const src = makeSolidPng(100, 100, [0, 0, 0, 255]);
    expect(() => cropPngBuffer(src, { x: 100, y: 100, width: 50, height: 50 })).toThrow(
      /zero area/,
    );
  });
});
