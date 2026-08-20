import { describe, expect, it } from "vitest";
import { filterContentPaths } from "../../src/engine/benchmark.ts";

const BASE = "https://blog.example.com/";

describe("filterContentPaths", () => {
  it("keeps internal content paths in DOM order, de-duplicated", () => {
    const hrefs = [
      "/blog",
      "/especialidades",
      "/blog", // dup
      "https://blog.example.com/artigos/x",
    ];
    expect(filterContentPaths(hrefs, BASE)).toEqual(["/blog", "/especialidades", "/artigos/x"]);
  });

  it("drops home, external hosts, and commerce/social/legal junk", () => {
    const hrefs = [
      "/", // home
      "https://instagram.com/x", // external + social
      "/carrinho", // commerce junk
      "/politica-de-privacidade", // legal junk
      "/login", // account junk
      "/sobre", // keep
    ];
    expect(filterContentPaths(hrefs, BASE)).toEqual(["/sobre"]);
  });

  it("drops non-http schemes (mailto/tel) and keeps real paths", () => {
    expect(filterContentPaths(["mailto:x@y.com", "tel:+55", "/ok"], BASE)).toEqual(["/ok"]);
  });
});
