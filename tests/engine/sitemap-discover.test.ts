import { describe, expect, it } from "vitest";
import { classifyPath, labelForDiscoveredPage } from "../../src/engine/sitemap-discover.ts";

describe("classifyPath", () => {
  it("classifies root as home", () => {
    expect(classifyPath("/")).toBe("home");
    expect(classifyPath("")).toBe("home");
  });

  it("classifies VTEX product URLs with /p suffix as pdp", () => {
    expect(classifyPath("/produto-bonito/p")).toBe("pdp");
    expect(classifyPath("/produto-bonito/p/")).toBe("pdp");
  });

  it("classifies URL ending with SKU id as pdp", () => {
    expect(classifyPath("/produto-bonito-12345")).toBe("pdp");
    expect(classifyPath("/produto-com-id-987654")).toBe("pdp");
  });

  it("classifies Shopify /products/ as pdp", () => {
    expect(classifyPath("/products/awesome-shirt")).toBe("pdp");
    expect(classifyPath("/product/single")).toBe("pdp");
  });

  it("classifies /collections/ and /categoria/ as plp", () => {
    expect(classifyPath("/collections/summer")).toBe("plp");
    expect(classifyPath("/collection/summer")).toBe("plp");
    expect(classifyPath("/categoria/calcas")).toBe("plp");
    expect(classifyPath("/category/jeans")).toBe("plp");
  });

  it("classifies single-segment slug as plp (VTEX department)", () => {
    expect(classifyPath("/vestidos")).toBe("plp");
    expect(classifyPath("/moda-feminina")).toBe("plp");
  });

  it("classifies search routes as plp", () => {
    expect(classifyPath("/search/foo")).toBe("plp");
    expect(classifyPath("/busca/foo")).toBe("plp");
  });

  it("bug-catcher: ignores trailing slash differences", () => {
    expect(classifyPath("/vestidos/")).toBe(classifyPath("/vestidos"));
  });

  it("classifies multi-segment non-PDP paths as other", () => {
    expect(classifyPath("/ajuda/contato")).toBe("other");
    expect(classifyPath("/sobre/equipe")).toBe("other");
  });

  it("classifies URLs with uppercase / special chars in slug as other", () => {
    // Heuristic for plp requires all-lowercase / hyphens. Uppercase falls through.
    expect(classifyPath("/Vestidos")).toBe("other");
  });
});

describe("labelForDiscoveredPage", () => {
  it("returns 'Home' for home", () => {
    expect(labelForDiscoveredPage("/", "home")).toBe("Home");
  });

  it("prefixes PLP and PDP labels", () => {
    expect(labelForDiscoveredPage("/vestidos", "plp")).toBe("PLP · /vestidos");
    expect(labelForDiscoveredPage("/p/123", "pdp")).toBe("PDP · /p/123");
  });

  it("returns 'Page' for other kinds", () => {
    expect(labelForDiscoveredPage("/contato", "other")).toBe("Page · /contato");
  });
});
