/**
 * Types for `parity extract` (M5) — single-site, AI-ready component
 * extraction. Kept in a dedicated file (separate from `schema.ts`, which
 * owns the prod×cand `run`/report types) because these shapes describe a
 * single-site artifact bundle with no comparison semantics at all.
 */

export interface DetectedComponent {
  /** Semantic role guessed for this component, e.g. "header", "shelf-1". */
  role: string;
  /** CSS selector that uniquely (enough) identifies this component. */
  selector: string;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}

export interface ExtractedComponentAssets {
  images: string[];
  backgroundImages: string[];
  fonts: string[];
}

export interface ExtractedComponentLink {
  href: string;
  text: string;
}

export interface ExtractedComponent {
  role: string;
  selector: string;
  html: string;
  computedStyles: Record<string, string> | null;
  screenshotPath: string;
  assets: ExtractedComponentAssets;
  links: ExtractedComponentLink[];
  textContent: string[];
}

/** One resolved page (home / category-auto / pdp-auto / literal path) with its extracted components. */
export interface ExtractedPage {
  url: string;
  path: string;
  components: ExtractedComponent[];
}

export interface ExtractBundle {
  url: string;
  timestamp: string;
  viewport: string;
  /** Flattened across all resolved pages — kept for the exact shape the spec asked for. */
  components: ExtractedComponent[];
  /** Per-page breakdown (present when `--pages` resolved to more than one page). */
  pages?: ExtractedPage[];
}
