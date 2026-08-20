import { describe, expect, it } from "vitest";
import { parseDecoPages } from "../../src/diff/sitemap.ts";

const BASE = "https://site.com.br/";

describe("parseDecoPages (deco sitemap fallback)", () => {
  it("keeps static pathTemplates as absolute URLs, deduped", () => {
    const out = parseDecoPages(
      [
        { pathTemplate: "/blog" },
        { pathTemplate: "/blog/post-a" },
        { pathTemplate: "/blog" }, // dup
        { pathTemplate: "/especialidades" },
      ],
      BASE,
    );
    expect(out).toEqual([
      "https://site.com.br/blog",
      "https://site.com.br/blog/post-a",
      "https://site.com.br/especialidades",
    ]);
  });

  it("drops dynamic routes (no param values to fill)", () => {
    const out = parseDecoPages(
      [
        { pathTemplate: "/produto/:slug" },
        { pathTemplate: "/cat/*" },
        { pathTemplate: "/x/{id}" },
        { pathTemplate: "/static" },
      ],
      BASE,
    );
    expect(out).toEqual(["https://site.com.br/static"]);
  });

  it("ignores malformed entries and non-arrays", () => {
    expect(parseDecoPages(null, BASE)).toEqual([]);
    expect(parseDecoPages({ nope: true }, BASE)).toEqual([]);
    expect(parseDecoPages([{}, { pathTemplate: 42 }, { pathTemplate: "relative" }], BASE)).toEqual(
      [],
    );
  });
});
