/**
 * Read the VTEX IO block tree from a rendered storefront page.
 *
 * VTEX IO (Store Framework) serializes its render-runtime into the page for
 * hydration as `window.__RUNTIME__`, whose `extensions` map is keyed by block
 * treePath (e.g. `store.home/flex-layout.row#deals/rich-text#promo`) → the
 * resolved component. This is the store's REAL declarative block structure —
 * far more reliable than DOM heuristics for VTEX stores.
 *
 * `readVtexBlockTree` returns `null` when the page isn't VTEX IO (no runtime),
 * which is the gate we use instead of `detectPlatform` (that can false-positive
 * on other platforms). The exact shape is read defensively — it's verified live
 * per store and unwanted keys are ignored.
 */

import type { Page } from "playwright";

export interface VtexBlock {
  /** Full block treePath, e.g. "store.home/flex-layout.row#deals". */
  treePath: string;
  /** Block id (leaf segment, without the `#instance` suffix), e.g. "flex-layout.row". */
  blockName: string;
  /** Resolved component path from the runtime, when present. */
  component: string | null;
  /** Parent treePath (the treePath minus its last segment), or null at the root. */
  parent: string | null;
  /**
   * The block's configured props — i.e. the CONTENT the merchant registered in
   * the CMS (banner images, texts, links, shelf config, …). Only JSON-safe
   * values are kept; large blobs are the reason blocks.json is the full tier.
   * `null` when the block has no props or they couldn't be serialized.
   */
  props: Record<string, unknown> | null;
}

/**
 * Leaf block id from a treePath: last `/` segment, with the `#instance`
 * suffix and any `app@version:` prefix stripped
 * (e.g. `vtex.menu@2.x:menu#foo` → `menu`).
 */
export function blockNameFromTreePath(treePath: string): string {
  const leaf = treePath.split("/").pop() ?? treePath;
  const noInstance = leaf.split("#")[0] ?? leaf;
  return noInstance.includes(":") ? noInstance.slice(noInstance.lastIndexOf(":") + 1) : noInstance;
}

/** Parent treePath (drop the last `/` segment), or null when there is none. */
export function parentTreePath(treePath: string): string | null {
  const i = treePath.lastIndexOf("/");
  return i > 0 ? treePath.slice(0, i) : null;
}

export async function readVtexBlockTree(page: Page): Promise<VtexBlock[] | null> {
  let paths: { treePath: string; component: string | null; props: Record<string, unknown> | null }[] | null;
  try {
    paths = await page.evaluate(() => {
      const rt = (window as unknown as { __RUNTIME__?: { extensions?: Record<string, unknown> } })
        .__RUNTIME__;
      if (!rt || !rt.extensions || typeof rt.extensions !== "object") return null;
      return Object.entries(rt.extensions).map(([treePath, ext]) => {
        const e = ext && typeof ext === "object" ? (ext as { component?: unknown; props?: unknown }) : {};
        // props = the merchant's registered CONTENT. Keep only a JSON-safe copy
        // and drop children/context noise; skip if it can't be serialized.
        let props: Record<string, unknown> | null = null;
        if (e.props && typeof e.props === "object") {
          try {
            const clean = JSON.parse(JSON.stringify(e.props)) as Record<string, unknown>;
            for (const k of ["children", "__context", "context"]) delete clean[k];
            props = Object.keys(clean).length ? clean : null;
          } catch {
            props = null;
          }
        }
        return { treePath, component: (e.component as string | null) ?? null, props };
      });
    });
  } catch {
    return null;
  }
  if (!paths || paths.length === 0) return null;
  return paths
    .map((p) => ({
      treePath: p.treePath,
      blockName: blockNameFromTreePath(p.treePath),
      component: p.component,
      parent: parentTreePath(p.treePath),
      props: p.props,
    }))
    // Drop `$`-prefixed slots (before/after/around layout hooks, e.g.
    // `$before_header.full`) — they're layout plumbing, not components.
    .filter((b) => b.blockName.length > 0 && !b.blockName.startsWith("$"));
}
