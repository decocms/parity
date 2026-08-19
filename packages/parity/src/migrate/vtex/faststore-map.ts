/**
 * Deterministic VTEX IO block → FastStore component mapper.
 *
 * VTEX IO's declarative blocks map cleanly onto FastStore's components for the
 * common cases; unknown/custom blocks get a `custom-component` strategy so the
 * agent knows to build them from the captured DOM/CSS/assets instead of picking
 * an off-the-shelf component. Pure + table-driven — unit-tested. Confidences
 * are coarse hints, not guarantees.
 */

import type { VtexBlock } from "./runtime.ts";

interface MapEntry {
  faststore: string;
  confidence: number;
}

/** Keyed by VTEX block id (or its first dotted segment). */
const TABLE: Record<string, MapEntry> = {
  "product-summary": { faststore: "ProductCard", confidence: 0.95 },
  shelf: { faststore: "ProductShelf", confidence: 0.9 },
  "product-shelf": { faststore: "ProductShelf", confidence: 0.92 },
  "flex-layout": { faststore: "FlexLayout", confidence: 0.9 },
  "rich-text": { faststore: "RichText", confidence: 0.97 },
  "responsive-layout": { faststore: "FlexLayout", confidence: 0.7 },
  image: { faststore: "Image", confidence: 0.9 },
  "list-context": { faststore: "ProductShelf", confidence: 0.6 },
  "slider-layout": { faststore: "Carousel", confidence: 0.85 },
  carousel: { faststore: "Carousel", confidence: 0.85 },
  "search-bar": { faststore: "SearchInput", confidence: 0.9 },
  "search-result": { faststore: "ProductGallery", confidence: 0.8 },
  minicart: { faststore: "Minicart", confidence: 0.9 },
  "add-to-cart-button": { faststore: "BuyButton", confidence: 0.9 },
  menu: { faststore: "Navbar", confidence: 0.7 },
  header: { faststore: "Navbar", confidence: 0.75 },
  footer: { faststore: "Footer", confidence: 0.9 },
  breadcrumb: { faststore: "Breadcrumb", confidence: 0.95 },
  "product-price": { faststore: "Price", confidence: 0.9 },
  "product-selling-price": { faststore: "Price", confidence: 0.85 },
  "product-list-price": { faststore: "Price", confidence: 0.85 },
  "product-images": { faststore: "ImageGallery", confidence: 0.85 },
  "sku-selector": { faststore: "SkuSelector", confidence: 0.85 },
  "product-name": { faststore: "ProductTitle", confidence: 0.85 },
};

export interface BlockMapping {
  vtex: string;
  faststore: string | null;
  confidence: number;
  strategy: "mapped" | "custom-component";
  /** How many block instances used this block id. */
  count: number;
}

function lookup(blockName: string): MapEntry | null {
  if (TABLE[blockName]) return TABLE[blockName]!;
  const head = blockName.split(".")[0]!;
  return TABLE[head] ?? null;
}

/** Map a block tree to unique block→FastStore mappings, ranked by frequency. */
export function mapVtexBlocksToFastStore(blocks: VtexBlock[]): BlockMapping[] {
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.blockName, (counts.get(b.blockName) ?? 0) + (b.repeated ?? 1));

  const out: BlockMapping[] = [];
  for (const [vtex, count] of counts) {
    const entry = lookup(vtex);
    if (entry) {
      out.push({ vtex, faststore: entry.faststore, confidence: entry.confidence, strategy: "mapped", count });
    } else {
      // Unknown or explicitly custom (`custom.*`) → build from captured source.
      out.push({ vtex, faststore: null, confidence: 0, strategy: "custom-component", count });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}
