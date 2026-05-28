import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

/**
 * Bounding-box analysis of a pixelmatch heatmap.
 *
 * `diffScreenshots()` writes a PNG where every differing pixel is colored
 * red (pixelmatch's default diff color). This module reads that PNG and
 * extracts coordinates so an LLM can answer "where in the image is the
 * diff?" instead of guessing from the percentage alone.
 *
 * Output shape:
 *   - boundingBox: smallest rect that contains EVERY diff pixel (one for the whole image)
 *   - hotspots: per-cluster bounding boxes, sorted by area desc (top-N for LLM focus)
 *
 * Algorithm: 8-connected components via flood fill. Pure scan over the
 * pixel buffer — no dependencies beyond pngjs (already in deps).
 */

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Number of diff pixels inside this box. Useful to rank hotspots. */
  pixelCount: number;
}

export interface HeatmapAnalysis {
  /** Image dimensions of the heatmap. */
  imageWidth: number;
  imageHeight: number;
  /** Total diff pixels found. */
  diffPixels: number;
  /** Percentage of pixels marked as different. */
  pctDiff: number;
  /** Single bbox covering ALL diff pixels (or null when no diff). */
  boundingBox: BBox | null;
  /** Per-region bounding boxes (connected components), sorted by area desc. */
  hotspots: BBox[];
}

/**
 * Default: max hotspots to return. The first few cover >95% of the diff
 * usually; more than that just adds noise for the LLM. Override via
 * `analyzeHeatmapRegions(path, { maxHotspots })`.
 */
const DEFAULT_MAX_HOTSPOTS = 5;

/**
 * Minimum component pixel count to count as a "hotspot". Anti-aliasing
 * artifacts can produce 1-2 pixel "diff" specks; we drop those so the
 * LLM doesn't chase noise. 50px ≈ a small icon.
 */
const DEFAULT_MIN_COMPONENT_PIXELS = 50;

export interface AnalyzeOptions {
  maxHotspots?: number;
  minComponentPixels?: number;
}

export function analyzeHeatmapRegions(
  pngPath: string,
  opts: AnalyzeOptions = {},
): HeatmapAnalysis {
  const png = PNG.sync.read(readFileSync(pngPath));
  return analyzeHeatmapBuffer(png.data, png.width, png.height, opts);
}

/**
 * Same analysis but on an in-memory pixel buffer. Lets tests fabricate
 * tiny synthetic heatmaps without writing PNGs to disk.
 */
export function analyzeHeatmapBuffer(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  opts: AnalyzeOptions = {},
): HeatmapAnalysis {
  const maxHotspots = opts.maxHotspots ?? DEFAULT_MAX_HOTSPOTS;
  const minPixels = opts.minComponentPixels ?? DEFAULT_MIN_COMPONENT_PIXELS;

  // Build a binary mask: 1 = diff pixel, 0 = unchanged.
  // pixelmatch's heatmap paints diff pixels in red. We treat ANY non-near-
  // grayscale RGB triplet with a strong red channel as a diff pixel.
  // Robust enough for pixelmatch's deterministic color choice.
  const mask = new Uint8Array(width * height);
  let diffPixels = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    // diff = red dominant + not gray. Threshold of 100 separates pure
    // diff red (~255,0,0 or ~255,80,80) from grayscale anti-alias and
    // the original screenshot pixels (pixelmatch keeps the prod copy as
    // a desaturated background, but we ignore those).
    if (r > 100 && r > g + 40 && r > b + 40) {
      mask[p] = 1;
      diffPixels++;
    }
  }

  const totalPixels = width * height;
  const pctDiff = totalPixels > 0 ? diffPixels / totalPixels : 0;

  if (diffPixels === 0) {
    return {
      imageWidth: width,
      imageHeight: height,
      diffPixels: 0,
      pctDiff: 0,
      boundingBox: null,
      hotspots: [],
    };
  }

  // Connected-components via flood fill. Visited array reuses bit-flags
  // in the mask: 0=unset, 1=diff-unvisited, 2=diff-visited.
  const components: BBox[] = [];
  // Stack-based BFS avoids deep recursion stacks on large images.
  const stack: number[] = [];
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p] !== 1) continue;
    // Start new component
    const componentMinX = p % width;
    const componentMinY = Math.floor(p / width);
    let cMinX = componentMinX;
    let cMinY = componentMinY;
    let cMaxX = componentMinX;
    let cMaxY = componentMinY;
    let cPixels = 0;
    stack.push(p);
    mask[p] = 2;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      cPixels++;
      const cx = cur % width;
      const cy = Math.floor(cur / width);
      if (cx < cMinX) cMinX = cx;
      if (cx > cMaxX) cMaxX = cx;
      if (cy < cMinY) cMinY = cy;
      if (cy > cMaxY) cMaxY = cy;
      // 8-connected neighbors
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const np = ny * width + nx;
          if (mask[np] !== 1) continue;
          mask[np] = 2;
          stack.push(np);
        }
      }
    }
    if (cPixels >= minPixels) {
      components.push({
        x: cMinX,
        y: cMinY,
        width: cMaxX - cMinX + 1,
        height: cMaxY - cMinY + 1,
        pixelCount: cPixels,
      });
    }
    // Track global bbox even when component is below threshold — the
    // overall boundingBox should still reflect every diff pixel.
    if (cMinX < minX) minX = cMinX;
    if (cMinY < minY) minY = cMinY;
    if (cMaxX > maxX) maxX = cMaxX;
    if (cMaxY > maxY) maxY = cMaxY;
  }

  // Sort hotspots by area desc and trim
  const sorted = components
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, maxHotspots);

  const boundingBox: BBox =
    maxX >= 0
      ? {
          x: minX,
          y: minY,
          width: maxX - minX + 1,
          height: maxY - minY + 1,
          pixelCount: diffPixels,
        }
      : { x: 0, y: 0, width: 0, height: 0, pixelCount: 0 };

  return {
    imageWidth: width,
    imageHeight: height,
    diffPixels,
    pctDiff,
    boundingBox,
    hotspots: sorted,
  };
}
