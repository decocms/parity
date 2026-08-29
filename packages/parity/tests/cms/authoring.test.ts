import { describe, expect, it } from "vitest";
import { collectionToArray, sectionsOf, summarizeSections, unwrapValue } from "../../src/cms/authoring.ts";

const swtch = (value: unknown) => ({
  $fnType: "switch",
  varyByKeys: ["locale"],
  cases: null,
  defaultCase: value,
  configurationSourceType: "contexts",
});

const data = {
  sections: {
    $fnType: "collection",
    values: {
      "200": { id: 200, $position: 1, $componentKey: "CategoryBlocks" },
      "100": {
        id: 100,
        $position: 0,
        $componentKey: "HeroSwiper",
        slides: { $fnType: "collection", values: { "1": { id: 1 }, "2": { id: 2 } } },
      },
    },
  },
};

describe("unwrapValue", () => {
  it("tira o envelope de locale e deixa valor cru em paz", () => {
    expect(unwrapValue(swtch("https://x.png"))).toBe("https://x.png");
    expect(unwrapValue("cru")).toBe("cru");
    expect(unwrapValue(null)).toBeNull();
  });
});

describe("collectionToArray", () => {
  it("aceita {values} e array, e nao explode em outra coisa", () => {
    expect(collectionToArray({ values: { a: { id: 1 } } })).toHaveLength(1);
    expect(collectionToArray([{ id: 1 }, { id: 2 }])).toHaveLength(2);
    expect(collectionToArray("nada")).toEqual([]);
  });
});

describe("sectionsOf", () => {
  it("ordena por $position, nao pela chave numerica", () => {
    expect(sectionsOf(data).map((s) => s.componentKey)).toEqual(["HeroSwiper", "CategoryBlocks"]);
  });
});

describe("summarizeSections", () => {
  it("conta colecoes aninhadas — e o que torna um diff legivel", () => {
    expect(summarizeSections(data)).toEqual(["HeroSwiper (slides=2)", "CategoryBlocks"]);
  });
});
