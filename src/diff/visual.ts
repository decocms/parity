import { readFileSync, writeFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface VisualDiffResult {
  width: number;
  height: number;
  diffPixels: number;
  totalPixels: number;
  pctDiff: number;
  heatmapPath: string;
  passed: boolean;
  reason?: string;
}

export interface VisualDiffOptions {
  /** Allow up to this fraction (0–1) of differing pixels before failing. */
  maxPctDiff?: number;
  /** Pixel diff sensitivity (0 = strict, 1 = loose). */
  threshold?: number;
}

const DEFAULTS: Required<VisualDiffOptions> = {
  maxPctDiff: 0.02,
  threshold: 0.1,
};

/**
 * Compare two PNG screenshots. Resizes to the smaller intersection if dimensions
 * differ slightly (common when content height differs by a few px) and writes
 * a heatmap PNG to `heatmapPath`.
 */
export function diffScreenshots(
  prodPath: string,
  candPath: string,
  heatmapPath: string,
  opts: VisualDiffOptions = {},
): VisualDiffResult {
  const cfg = { ...DEFAULTS, ...opts };
  const prod = PNG.sync.read(readFileSync(prodPath));
  const cand = PNG.sync.read(readFileSync(candPath));

  const width = Math.min(prod.width, cand.width);
  const height = Math.min(prod.height, cand.height);

  const prodCropped = cropPng(prod, width, height);
  const candCropped = cropPng(cand, width, height);
  const diff = new PNG({ width, height });

  const diffPixels = pixelmatch(
    prodCropped.data,
    candCropped.data,
    diff.data,
    width,
    height,
    { threshold: cfg.threshold },
  );

  writeFileSync(heatmapPath, PNG.sync.write(diff));

  const totalPixels = width * height;
  const pctDiff = totalPixels > 0 ? diffPixels / totalPixels : 0;
  const passed = pctDiff <= cfg.maxPctDiff;

  return {
    width,
    height,
    diffPixels,
    totalPixels,
    pctDiff,
    heatmapPath,
    passed,
    reason: passed
      ? undefined
      : `visual diff ${(pctDiff * 100).toFixed(2)}% > ${(cfg.maxPctDiff * 100).toFixed(2)}%`,
  };
}

function cropPng(src: PNG, w: number, h: number): PNG {
  if (src.width === w && src.height === h) return src;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const srcStart = y * src.width * 4;
    const outStart = y * w * 4;
    src.data.copy(out.data, outStart, srcStart, srcStart + w * 4);
  }
  return out;
}
