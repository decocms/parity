import { describe, expect, it } from "vitest";
import { mapVtexBlocksToFastStore } from "../../src/migrate/vtex/faststore-map.ts";
import {
  blockNameFromTreePath,
  dedupeVtexBlocks,
  parentTreePath,
  type VtexBlock,
} from "../../src/migrate/vtex/runtime.ts";

describe("blockNameFromTreePath / parentTreePath", () => {
  it("strips instance suffix and returns the leaf block id", () => {
    expect(blockNameFromTreePath("store.home/flex-layout.row#deals/rich-text#promo")).toBe("rich-text");
    expect(blockNameFromTreePath("store.home/shelf#home")).toBe("shelf");
    expect(blockNameFromTreePath("store.home")).toBe("store.home");
  });
  it("strips an app@version: prefix from the leaf", () => {
    expect(blockNameFromTreePath("store.home/vtex.menu@2.x:menu#main")).toBe("menu");
  });
  it("computes the parent treePath", () => {
    expect(parentTreePath("store.home/flex-layout.row#deals/rich-text#promo")).toBe(
      "store.home/flex-layout.row#deals",
    );
    expect(parentTreePath("store.home")).toBeNull();
  });
});

describe("dedupeVtexBlocks", () => {
  const b = (treePath: string, blockName: string, props: Record<string, unknown> | null): VtexBlock => ({
    treePath,
    blockName,
    component: null,
    parent: null,
    props,
  });

  it("collapses identical blocks (same name + props) with a repeated count", () => {
    const out = dedupeVtexBlocks([
      b("store.plp/ps#1", "product-summary", null),
      b("store.plp/ps#2", "product-summary", null),
      b("store.plp/ps#3", "product-summary", null),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.repeated).toBe(3);
  });

  it("keeps blocks with distinct content (different props)", () => {
    const out = dedupeVtexBlocks([
      b("store.home/b#1", "banner", { image: "/a.jpg" }),
      b("store.home/b#2", "banner", { image: "/b.jpg" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((x) => (x.repeated ?? 1) === 1)).toBe(true);
  });
});

describe("mapVtexBlocksToFastStore", () => {
  const blocks: VtexBlock[] = [
    { treePath: "store.home/shelf#a", blockName: "shelf", component: null, parent: "store.home", props: null },
    { treePath: "store.home/shelf#b", blockName: "shelf", component: null, parent: "store.home", props: null },
    { treePath: "store.home/product-summary#1", blockName: "product-summary", component: null, parent: "store.home/shelf#a", props: null },
    { treePath: "store.home/flex-layout.row#x", blockName: "flex-layout.row", component: null, parent: "store.home", props: null },
    { treePath: "store.home/custom.my-banner#1", blockName: "custom.my-banner", component: null, parent: "store.home", props: { title: "Promo" } },
  ];

  it("maps known blocks (incl. dotted head) and ranks by frequency", () => {
    const map = mapVtexBlocksToFastStore(blocks);
    const shelf = map.find((m) => m.vtex === "shelf")!;
    expect(shelf).toMatchObject({ faststore: "ProductShelf", strategy: "mapped", count: 2 });
    expect(map[0]!.count).toBe(2); // shelf is most frequent, ranked first
    expect(map.find((m) => m.vtex === "product-summary")!.faststore).toBe("ProductCard");
    // "flex-layout.row" resolves via its dotted head "flex-layout".
    expect(map.find((m) => m.vtex === "flex-layout.row")!.faststore).toBe("FlexLayout");
  });

  it("falls back to custom-component for unknown/custom blocks", () => {
    const map = mapVtexBlocksToFastStore(blocks);
    const custom = map.find((m) => m.vtex === "custom.my-banner")!;
    expect(custom).toMatchObject({ faststore: null, strategy: "custom-component", confidence: 0 });
  });
});
