/**
 * Types for `parity migrate` — phased, single-site migration capture.
 *
 * Kept separate from `extract.ts` (which owns the raw component snapshot)
 * because these shapes add a migration-oriented layer on top: a site-wide
 * theme, Tailwind as a first-class intermediate representation, light
 * interaction hints + suggested e2e selectors, and a page-kind-aware
 * component tree. A `MigratedComponent` embeds an `ExtractedComponent`'s
 * fields rather than duplicating them, so the raw HTML / computed styles /
 * assets stay available as the fallback tier.
 */

import type { PageKind } from "../engine/sitemap-discover.ts";
import type { Platform } from "../learned/platform.ts";
import type { StackSignals } from "../migrate/sources/classify.ts";
import type { BlockMapping } from "../migrate/vtex/faststore-map.ts";
import type { VtexBlock } from "../migrate/vtex/runtime.ts";
import type { ExtractedComponent } from "./extract.ts";

/** A single color observed on the site, ranked by how often it appears. */
export interface ThemeColor {
  /** Normalized CSS color (rgb(...) as the browser reports it). */
  value: string;
  /** Occurrence count across the sampled elements — drives primary/secondary election. */
  count: number;
  /** Suggested Tailwind token name (e.g. "primary", "neutral-900"). */
  token: string;
}

/** Site-wide theme extracted in Phase 1. Feeds the target's design tokens. */
export interface ThemeBundle {
  colors: {
    primary: string | null;
    secondary: string | null;
    background: string | null;
    text: string | null;
    /** Full frequency-ranked palette (deduped). */
    palette: ThemeColor[];
  };
  typography: {
    /** Distinct font-family stacks, most-used first. */
    fontFamilies: string[];
    /** Sorted unique font-size values (ascending), e.g. ["12px","14px","16px"]. */
    sizeScale: string[];
  };
  /** Sorted unique spacing values seen in gap/padding (ascending). */
  spacingScale: string[];
  /** Sorted unique border-radius values. */
  radii: string[];
  /** Distinct box-shadow values. */
  shadows: string[];
  /** Distinct breakpoint widths (px) from @media rules, ascending. */
  breakpoints: string[];
  /** Deterministic motion tokens declared on the page. */
  motion: {
    /** Distinct transition/animation durations, e.g. ["0.2s","300ms"]. */
    durations: string[];
    /** Distinct timing functions, e.g. ["ease","cubic-bezier(...)"]. */
    easings: string[];
  };
  /**
   * Flat token map ready to drop into a target theme config
   * (e.g. `{ "--color-primary": "rgb(228, 0, 43)" }`). Token → value.
   */
  tokens: Record<string, string>;
}

/** An icon used by the UI — for mapping to the target's icon set (e.g. Phosphor). */
export interface IconRef {
  /** "inline-svg" | "svg-use" | "icon-font". */
  kind: string;
  /** Symbol id, aria-label/class, or icon-font token. */
  id: string;
  count: number;
}

/** Raw site-asset references read in-page (before download). */
export interface RawSiteAssets {
  favicon: string | null;
  appleTouchIcon: string | null;
  manifest: string | null;
  ogImage: string | null;
  fonts: string[];
  logo: { type: "img"; url: string } | { type: "svg"; markup: string } | null;
  icons: IconRef[];
}

/** Brand + meta assets, with local paths after download to `<out>/assets/`. */
export interface SiteAssets {
  /** Local path (under the out dir) to the downloaded logo, or null. */
  logo: string | null;
  /** Original logo URL, or "inline-svg" when captured from markup. */
  logoSource: string | null;
  favicon: string | null;
  faviconSource: string | null;
  appleTouchIcon: string | null;
  ogImage: string | null;
  /** Web app manifest URL (referenced, not downloaded). */
  manifest: string | null;
  /** Web-font source URLs (from preload links + `@font-face`). */
  fonts: string[];
  /** Downloaded web-font files (local paths under the out dir). */
  fontFiles: string[];
  /** Deduped icon inventory. */
  icons: IconRef[];
}

/** One interactive element with its declared states + a suggested e2e selector. */
export interface InteractionHint {
  /** Suggested CSS selector for an e2e test to target this element. */
  selector: string;
  /** Coarse kind: "button" | "link" | "input" | "select" | "clickable". */
  kind: string;
  /** Visible label / aria-label, trimmed. */
  label: string;
  /**
   * Recognized `SelectorKey` (from src/learned/repo.ts) when the element
   * maps to a known commerce affordance (add-to-cart, search-input, …).
   * `null` when it's a generic interactive element.
   */
  e2eKey: string | null;
  /** Declared transition/animation shorthand, if any (from computed style). */
  animation: string | null;
  /** Whether a `:hover` / `:focus` rule was declared for this element in the CSSOM. */
  hasHoverRule: boolean;
  hasFocusRule: boolean;
}

/** A captured component enriched for migration. */
export interface MigratedComponent extends ExtractedComponent {
  /** Deterministic Tailwind classes translated from computed styles (core IR). */
  tailwind: string[];
  /** Light interaction hints + suggested e2e selectors. */
  interactions: InteractionHint[];
  /** "global" = appears on every page (header/footer/minicart); "page" = page-specific. */
  scope: "global" | "page";
  /**
   * When N structurally-identical instances of this component were detected
   * on the page (e.g. a row of shelves/carousels), this is that count and
   * only ONE representative is captured. Absent (or 1) when unique.
   */
  repeated?: number;
  /**
   * True when this row was NOT captured live: the source repo defines the
   * component but it never appeared in the DOM snapshot (unused/edge route).
   * Its html/styles/screenshot are empty — the agent ports it from the source
   * code, not from a capture.
   */
  synthetic?: boolean;
}

/** One resolved page with its enriched components. */
export interface MigratedPage {
  url: string;
  path: string;
  kind: PageKind;
  components: MigratedComponent[];
}

/** The full migration artifact (Phase 1 theme + Phase 2/3 pages/components). */
export interface MigrationBundle {
  url: string;
  timestamp: string;
  viewport: string;
  /** Detected commerce platform (vtex, vtex-fs, shopify, …). */
  platform: Platform;
  /** Sharp stack verdict: frontend to migrate FROM + htmx + commerce backend. */
  stack?: StackSignals | null;
  /** Selected target playbook name, when `--target` was passed. */
  target?: string;
  /** Viewports captured for the theme + site screenshots. */
  viewports?: string[];
  /** Full-page site screenshots, one per viewport (path under the out dir). */
  screenshots?: { viewport: string; path: string }[];
  theme: ThemeBundle;
  /** Brand + meta assets (logo/favicon/…) + icon inventory. */
  assets: SiteAssets;
  /** VTEX IO declarative block tree + FastStore mapping (present only for VTEX IO stores). */
  vtex?: { blocks: VtexBlock[]; map: BlockMapping[] };
  pages: MigratedPage[];
  /** Flattened across all pages, globals first. */
  components: MigratedComponent[];
}
