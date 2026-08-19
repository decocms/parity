import { describe, expect, it } from "vitest";
import {
  breadcrumbJsonLdDepth,
  detectBreadcrumbs,
  hasAnyBreadcrumbSignal,
  hasBreadcrumbMarkup,
} from "../../../src/checks/lib/breadcrumb-detect.ts";

const HTML_MARKUP = `<html><body><nav aria-label="Breadcrumb"><a href="/">Home</a></nav></body></html>`;
const HTML_CLASS_ONLY = `<html><body><div class="product-breadcrumb-trail">Home / Shirts</div></body></html>`;
const HTML_JSONLD = `<html><head><script type="application/ld+json">${JSON.stringify({
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home" },
    { "@type": "ListItem", position: 2, name: "Shirts" },
  ],
})}</script></head><body></body></html>`;
const HTML_NONE = "<html><body><div>Nothing here</div></body></html>";

describe("hasBreadcrumbMarkup", () => {
  it("detects nav[aria-label*=breadcrumb]", () => {
    expect(hasBreadcrumbMarkup(HTML_MARKUP)).toBe(true);
  });
  it("detects class*=breadcrumb", () => {
    expect(hasBreadcrumbMarkup(HTML_CLASS_ONLY)).toBe(true);
  });
  it("returns false for markup-less HTML", () => {
    expect(hasBreadcrumbMarkup(HTML_NONE)).toBe(false);
  });
});

describe("breadcrumbJsonLdDepth", () => {
  it("returns itemListElement length when BreadcrumbList JSON-LD is present", () => {
    expect(breadcrumbJsonLdDepth(HTML_JSONLD)).toBe(2);
  });
  it("returns 0 when no BreadcrumbList JSON-LD present", () => {
    expect(breadcrumbJsonLdDepth(HTML_NONE)).toBe(0);
  });
});

describe("detectBreadcrumbs / hasAnyBreadcrumbSignal", () => {
  it("markup-only page: markup=true, jsonLd=false", () => {
    const s = detectBreadcrumbs(HTML_MARKUP);
    expect(s.markup).toBe(true);
    expect(s.jsonLd).toBe(false);
    expect(hasAnyBreadcrumbSignal(HTML_MARKUP)).toBe(true);
  });

  it("JSON-LD-only page: jsonLd=true", () => {
    const s = detectBreadcrumbs(HTML_JSONLD);
    expect(s.jsonLd).toBe(true);
    expect(s.jsonLdDepth).toBe(2);
    expect(hasAnyBreadcrumbSignal(HTML_JSONLD)).toBe(true);
  });

  it("neither signal present: hasAnyBreadcrumbSignal is false", () => {
    expect(hasAnyBreadcrumbSignal(HTML_NONE)).toBe(false);
  });
});
