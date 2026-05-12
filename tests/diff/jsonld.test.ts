import { describe, expect, it } from "vitest";
import {
  diffBreadcrumbSchema,
  diffOrganizationSchema,
  diffProductSchema,
  extractJsonLd,
} from "../../src/diff/jsonld.ts";

function html(ld: unknown): string {
  return `<html><head><script type="application/ld+json">${typeof ld === "string" ? ld : JSON.stringify(ld)}</script></head><body></body></html>`;
}

describe("extractJsonLd", () => {
  it("extracts a single typed block", () => {
    const m = extractJsonLd(html({ "@type": "Product", name: "Foo" }));
    expect(m.get("Product")?.length).toBe(1);
    expect(m.get("Product")?.[0]?.name).toBe("Foo");
  });

  it("extracts multiple blocks across script tags", () => {
    const x = `<html><head>
      <script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "A" })}</script>
      <script type="application/ld+json">${JSON.stringify({ "@type": "BreadcrumbList", itemListElement: [1, 2] })}</script>
    </head></html>`;
    const m = extractJsonLd(x);
    expect(m.has("Product")).toBe(true);
    expect(m.has("BreadcrumbList")).toBe(true);
  });

  it("handles JSON arrays at top level", () => {
    const m = extractJsonLd(html([
      { "@type": "Product", name: "A" },
      { "@type": "Organization", name: "Acme" },
    ]));
    expect(m.has("Product")).toBe(true);
    expect(m.has("Organization")).toBe(true);
  });

  it("handles @graph collection", () => {
    const m = extractJsonLd(html({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Product", name: "P" },
        { "@type": "Organization", name: "Acme" },
      ],
    }));
    expect(m.has("Product")).toBe(true);
    expect(m.has("Organization")).toBe(true);
  });

  it("handles @type as array (multi-typed entity)", () => {
    const m = extractJsonLd(html({ "@type": ["Product", "Offer"], name: "X" }));
    expect(m.has("Product")).toBe(true);
    expect(m.has("Offer")).toBe(true);
  });

  it("returns empty map for invalid JSON-LD without crashing", () => {
    const m = extractJsonLd(html("{not valid json"));
    expect(m.size).toBe(0);
  });

  it("returns empty map for HTML without JSON-LD", () => {
    expect(extractJsonLd("<html><body>nothing</body></html>").size).toBe(0);
  });

  it("bug #20: handles JSON-LD array containing null without crashing", () => {
    const x = `<html><head><script type="application/ld+json">${JSON.stringify([null, { "@type": "Product", name: "OK" }])}</script></head></html>`;
    expect(() => extractJsonLd(x)).not.toThrow();
    const m = extractJsonLd(x);
    expect(m.has("Product")).toBe(true);
  });

  it("ignores entries with non-string @type values", () => {
    const m = extractJsonLd(html({ "@type": 123, name: "X" }));
    expect(m.size).toBe(0);
  });
});

describe("diffProductSchema", () => {
  it("flags Product missing in cand", () => {
    const prod = extractJsonLd(html({ "@type": "Product", name: "Tênis", sku: "1" }));
    const cand = extractJsonLd("<html></html>");
    const d = diffProductSchema(prod, cand);
    expect(d.prodOnly).toBe(true);
    expect(d.bothPresent).toBe(false);
  });

  it("flags missing required fields in cand", () => {
    const prod = extractJsonLd(html({
      "@type": "Product",
      name: "Tênis",
      sku: "1",
      offers: { price: 100, priceCurrency: "BRL", availability: "InStock" },
    }));
    const cand = extractJsonLd(html({
      "@type": "Product",
      name: "Tênis",
      // sku, image, brand, description, offers.* missing
    }));
    const d = diffProductSchema(prod, cand);
    expect(d.bothPresent).toBe(true);
    expect(d.missingFieldsInCand).toContain("sku");
    expect(d.missingFieldsInCand).toContain("offers.price");
  });

  it("detects price change beyond 1% tolerance", () => {
    const prod = extractJsonLd(html({ "@type": "Product", name: "X", offers: { price: 100 } }));
    const cand = extractJsonLd(html({ "@type": "Product", name: "X", offers: { price: 110 } }));
    const d = diffProductSchema(prod, cand);
    expect(d.changedFields.some((c) => c.field === "offers.price")).toBe(true);
  });

  it("tolerates price within 1%", () => {
    const prod = extractJsonLd(html({ "@type": "Product", name: "X", offers: { price: 100 } }));
    const cand = extractJsonLd(html({ "@type": "Product", name: "X", offers: { price: 100.5 } }));
    const d = diffProductSchema(prod, cand);
    expect(d.changedFields.some((c) => c.field === "offers.price")).toBe(false);
  });

  it("handles price as string with BR-format decimal", () => {
    const prod = extractJsonLd(html({ "@type": "Product", name: "X", offers: { price: "100,00" } }));
    const cand = extractJsonLd(html({ "@type": "Product", name: "X", offers: { price: "100.00" } }));
    const d = diffProductSchema(prod, cand);
    expect(d.changedFields.some((c) => c.field === "offers.price")).toBe(false);
  });

  it("compares strings case + whitespace insensitively for name", () => {
    const prod = extractJsonLd(html({ "@type": "Product", name: "  Tênis Esporte  " }));
    const cand = extractJsonLd(html({ "@type": "Product", name: "tênis  esporte" }));
    const d = diffProductSchema(prod, cand);
    expect(d.changedFields.some((c) => c.field === "name")).toBe(false);
  });
});

describe("diffBreadcrumbSchema", () => {
  it("counts itemListElement length", () => {
    const prod = extractJsonLd(html({ "@type": "BreadcrumbList", itemListElement: [1, 2, 3] }));
    const cand = extractJsonLd(html({ "@type": "BreadcrumbList", itemListElement: [1, 2] }));
    const d = diffBreadcrumbSchema(prod, cand);
    expect(d.bothPresent).toBe(true);
    expect(d.prodItemCount).toBe(3);
    expect(d.candItemCount).toBe(2);
  });

  it("returns 0 count when itemListElement is missing", () => {
    const prod = extractJsonLd(html({ "@type": "BreadcrumbList" }));
    const cand = extractJsonLd("<html></html>");
    expect(diffBreadcrumbSchema(prod, cand).prodItemCount).toBe(0);
  });
});

describe("diffOrganizationSchema", () => {
  it("reports presence in each side", () => {
    const prod = extractJsonLd(html({ "@type": "Organization", name: "Acme" }));
    const cand = extractJsonLd("<html></html>");
    const d = diffOrganizationSchema(prod, cand);
    expect(d.prodPresent).toBe(true);
    expect(d.candPresent).toBe(false);
  });
});
