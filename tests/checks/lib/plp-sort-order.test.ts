import { describe, expect, it } from "vitest";
import {
  extractOrderedProductHrefs,
  sortOrderChanged,
} from "../../../src/checks/lib/plp-sort-order.ts";

describe("extractOrderedProductHrefs", () => {
  it("extracts /p hrefs in DOM order, deduped", () => {
    const html = `
      <a href="/product-a/p">A</a>
      <a href="/product-b/p?skuId=1">B</a>
      <a href="/product-a/p">A again</a>
      <a href="/product-c/p">C</a>
    `;
    expect(extractOrderedProductHrefs(html)).toEqual([
      "/product-a/p",
      "/product-b/p",
      "/product-c/p",
    ]);
  });

  it("extracts /products/ hrefs too", () => {
    const html = `<a href="/products/shirt">Shirt</a><a href="/products/pants?color=blue">Pants</a>`;
    expect(extractOrderedProductHrefs(html)).toEqual(["/products/shirt", "/products/pants"]);
  });

  it("returns empty array for HTML with no product links", () => {
    expect(extractOrderedProductHrefs("<div>no products here</div>")).toEqual([]);
  });
});

describe("sortOrderChanged", () => {
  it("returns false when either list is empty", () => {
    expect(sortOrderChanged([], ["/a"])).toBe(false);
    expect(sortOrderChanged(["/a"], [])).toBe(false);
  });

  it("returns false when order is identical (sort silently no-op)", () => {
    expect(sortOrderChanged(["/a", "/b", "/c"], ["/a", "/b", "/c"])).toBe(false);
  });

  it("returns true when order differs", () => {
    expect(sortOrderChanged(["/a", "/b", "/c"], ["/c", "/b", "/a"])).toBe(true);
  });

  it("returns true when the sorted list has a different first item", () => {
    expect(sortOrderChanged(["/a", "/b"], ["/b", "/a"])).toBe(true);
  });
});
