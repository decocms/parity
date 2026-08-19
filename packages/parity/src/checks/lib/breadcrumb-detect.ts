import { extractJsonLd } from "../../diff/jsonld.ts";

/**
 * Pure breadcrumb-presence detection for `pdp-breadcrumbs.ts` — extracted
 * so it can be unit tested against raw HTML fixtures without a full
 * PageCapture.
 */
export interface BreadcrumbSignal {
  /** Markup-level signal: a nav/element that looks like a breadcrumb trail. */
  markup: boolean;
  /** Structured-data signal: a schema.org BreadcrumbList JSON-LD block. */
  jsonLd: boolean;
  /** itemListElement length of the first BreadcrumbList found (0 if none). */
  jsonLdDepth: number;
}

const MARKUP_PATTERNS: RegExp[] = [
  /<nav[^>]+aria-label=["'][^"']*breadcrumb[^"']*["']/i,
  /class=["'][^"']*breadcrumb[^"']*["']/i,
  /data-breadcrumb/i,
];

/** True when the HTML contains a nav/class/data-attribute breadcrumb marker. */
export function hasBreadcrumbMarkup(html: string): boolean {
  return MARKUP_PATTERNS.some((re) => re.test(html));
}

/** itemListElement.length of the first BreadcrumbList JSON-LD block, or 0. */
export function breadcrumbJsonLdDepth(html: string): number {
  const map = extractJsonLd(html);
  const list = map.get("BreadcrumbList")?.[0];
  const items = list?.itemListElement;
  return Array.isArray(items) ? items.length : 0;
}

/** Combined signal used by the check: either markup OR JSON-LD counts as "has breadcrumbs". */
export function detectBreadcrumbs(html: string): BreadcrumbSignal {
  const jsonLdDepth = breadcrumbJsonLdDepth(html);
  return {
    markup: hasBreadcrumbMarkup(html),
    jsonLd: jsonLdDepth > 0,
    jsonLdDepth,
  };
}

export function hasAnyBreadcrumbSignal(html: string): boolean {
  const s = detectBreadcrumbs(html);
  return s.markup || s.jsonLd;
}
