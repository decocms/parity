import { describe, expect, it } from "vitest";
import { aggregateIcons } from "../../src/migrate/assets.ts";

describe("aggregateIcons", () => {
  it("dedupes by kind+id and sums counts, ranked desc", () => {
    const out = aggregateIcons([
      { kind: "svg-use", id: "cart", count: 1 },
      { kind: "svg-use", id: "cart", count: 1 },
      { kind: "svg-use", id: "cart", count: 1 },
      { kind: "icon-font", id: "fa-search", count: 1 },
      { kind: "svg-use", id: "user", count: 1 },
    ]);
    expect(out[0]).toEqual({ kind: "svg-use", id: "cart", count: 3 });
    expect(out).toHaveLength(3);
  });

  it("does not merge same id across different kinds, drops empties", () => {
    const out = aggregateIcons([
      { kind: "svg-use", id: "cart", count: 1 },
      { kind: "inline-svg", id: "cart", count: 1 },
      { kind: "icon-font", id: "  ", count: 1 },
    ]);
    expect(out).toHaveLength(2);
  });
});
