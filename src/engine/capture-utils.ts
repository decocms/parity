import { PNG } from "pngjs";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Crop a PNG buffer to the given bounding box. Clamps the box to the source
 * dimensions so callers don't have to (Playwright `boundingBox()` can return
 * fractional values that, after rounding, may sit one pixel outside the page).
 *
 * Returns a PNG buffer of exactly `box.width × box.height`. The caller writes
 * it to disk — keeping I/O outside makes this pure and testable.
 *
 * Throws if the box has zero area or doesn't intersect the source at all.
 */
export function cropPngBuffer(srcBuffer: Buffer, box: BoundingBox): Buffer {
  const src = PNG.sync.read(srcBuffer);
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const w = Math.max(0, Math.min(Math.ceil(box.width), src.width - x));
  const h = Math.max(0, Math.min(Math.ceil(box.height), src.height - y));
  if (w === 0 || h === 0) {
    throw new Error(
      `cropPngBuffer: bounding box has zero area after clamp (box=${JSON.stringify(box)} src=${src.width}x${src.height})`,
    );
  }
  const out = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * src.width + x) * 4;
    const outStart = row * w * 4;
    src.data.copy(out.data, outStart, srcStart, srcStart + w * 4);
  }
  return PNG.sync.write(out);
}
