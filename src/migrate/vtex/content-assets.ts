/**
 * Download the image assets referenced inside VTEX block `props` (the CMS
 * content — banner images, etc.) and rewrite those URLs to the local copies,
 * so the migration bundle carries the store's actual content images and
 * `blocks.json` points at files you can re-upload to the target.
 *
 * `collectImageUrls` and `rewriteBlockUrls` are pure (unit-tested);
 * `downloadContentImages` does the browser-routed I/O.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchBytes } from "../assets.ts";
import type { VtexBlock } from "./runtime.ts";

/** Max content images to download per run (keeps big catalogs bounded). */
const MAX_IMAGES = 150;

const IMG_EXT = /\.(jpe?g|png|webp|gif|svg|avif)(\?|#|$)/i;
const VTEX_ASSET = /vtexassets\.com|vteximg\.com\.br|\/arquivos\/(ids|assets)\//i;

/** An absolute image URL (http(s):// or protocol-relative). */
export function isImageUrl(s: string): boolean {
  if (typeof s !== "string") return false;
  const v = s.trim();
  if (!/^(https?:)?\/\//i.test(v)) return false;
  return IMG_EXT.test(v) || VTEX_ASSET.test(v);
}

/**
 * An image REFERENCE in props — absolute OR a site-relative pointer
 * (`/img/x`, `/arquivos/ids/123`) which VTEX stores use a lot. Relative refs
 * are resolved to the real content URL against the store origin.
 */
export function isImageRef(s: string): boolean {
  if (typeof s !== "string") return false;
  const v = s.trim();
  if (isImageUrl(v)) return true;
  return v.startsWith("/") && !v.startsWith("//") && (IMG_EXT.test(v) || VTEX_ASSET.test(v) || v.startsWith("/img/"));
}

/** Resolve an image ref to an absolute URL against the store base. */
export function resolveRef(ref: string, baseUrl: string): string | null {
  const v = ref.trim();
  try {
    if (v.startsWith("//")) return `https:${v}`;
    return new URL(v, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Walk every block's props and return a map of the ORIGINAL prop string →
 * resolved absolute URL, for each image reference (relative or absolute).
 */
export function collectImageRefs(blocks: VtexBlock[], baseUrl: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const s = v.trim();
      if (isImageRef(s) && !(s in out)) {
        const abs = resolveRef(s, baseUrl);
        if (abs) out[s] = abs;
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  for (const b of blocks) if (b.props) walk(b.props);
  return out;
}

/** Count distinct absolute image URLs referenced across all block props. */
export function countContentImages(blocks: VtexBlock[]): number {
  const urls = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (isImageUrl(v.trim())) urls.add(v.trim());
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  for (const b of blocks) if (b.props) walk(b.props);
  return urls.size;
}

/** Deep-clone blocks with every props image URL swapped for its local path. */
export function rewriteBlockUrls(
  blocks: VtexBlock[],
  urlToPath: Record<string, string>,
): VtexBlock[] {
  const replace = (v: unknown): unknown => {
    if (typeof v === "string") return urlToPath[v.trim()] ?? v;
    if (Array.isArray(v)) return v.map(replace);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = replace(val);
      return out;
    }
    return v;
  };
  return blocks.map((b) => ({
    ...b,
    props: b.props ? (replace(b.props) as Record<string, unknown>) : b.props,
  }));
}

/** Filename for a content image: sanitized basename, deduped by index. */
export function contentImageName(url: string, index: number, used: Set<string>): string {
  let base = "img";
  try {
    base = new URL(url, "https://x").pathname.split("/").filter(Boolean).pop() ?? "img";
  } catch {
    /* keep default */
  }
  base = base.split("?")[0]!.replace(/[^\w.-]/g, "_").slice(-60) || "img";
  if (!/\.(jpe?g|png|webp|gif|svg|avif)$/i.test(base)) base += ".img";
  let name = base;
  if (used.has(name)) name = `${index}-${base}`;
  used.add(name);
  return name;
}

/**
 * Download the collected image URLs to `<runDir>/assets/content/` and return a
 * `url → local relative path` map (only successfully downloaded ones). Capped
 * at MAX_IMAGES; the caller logs how many were skipped.
 */
export async function downloadContentImages(
  urls: string[],
  runDir: string,
  fetchBytes: FetchBytes,
): Promise<{ map: Record<string, string>; downloaded: number; skipped: number }> {
  const map: Record<string, string> = {};
  if (urls.length === 0) return { map, downloaded: 0, skipped: 0 };
  const dir = join(runDir, "assets", "content");
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  const take = urls.slice(0, MAX_IMAGES);
  let downloaded = 0;
  for (const [i, url] of take.entries()) {
    const got = await fetchBytes(url.startsWith("//") ? `https:${url}` : url);
    if (!got) continue;
    const name = contentImageName(url, i, used);
    writeFileSync(join(dir, name), got.buf);
    map[url] = `assets/content/${name}`;
    downloaded++;
  }
  return { map, downloaded, skipped: Math.max(0, urls.length - take.length) };
}
