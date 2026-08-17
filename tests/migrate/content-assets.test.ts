import { describe, expect, it } from "vitest";
import {
  collectImageRefs,
  contentImageName,
  countContentImages,
  isImageRef,
  isImageUrl,
  resolveRef,
  rewriteBlockUrls,
} from "../../src/migrate/vtex/content-assets.ts";
import type { VtexBlock } from "../../src/migrate/vtex/runtime.ts";

function block(props: Record<string, unknown> | null): VtexBlock {
  return { treePath: "store.home/x", blockName: "x", component: null, parent: null, props };
}

describe("isImageUrl / isImageRef", () => {
  it("isImageUrl accepts absolute image URLs + VTEX asset hosts", () => {
    expect(isImageUrl("https://cdn.com/banner.png?v=2")).toBe(true);
    expect(isImageUrl("https://loja.vtexassets.com/arquivos/ids/12345")).toBe(true);
    expect(isImageUrl("/arquivos/ids/12345")).toBe(false); // relative, not a URL
  });
  it("isImageRef also accepts site-relative pointers", () => {
    expect(isImageRef("/arquivos/ids/12345")).toBe(true);
    expect(isImageRef("/img/banner.png")).toBe(true);
    expect(isImageRef("https://cdn.com/a.jpg")).toBe(true);
    expect(isImageRef("/page.html")).toBe(false);
    expect(isImageRef("hello")).toBe(false);
  });
});

describe("resolveRef", () => {
  it("resolves relative pointers against the store base", () => {
    expect(resolveRef("/arquivos/ids/999", "https://loja.com")).toBe("https://loja.com/arquivos/ids/999");
    expect(resolveRef("//cdn.com/a.jpg", "https://loja.com")).toBe("https://cdn.com/a.jpg");
    expect(resolveRef("https://cdn.com/a.jpg", "https://loja.com")).toBe("https://cdn.com/a.jpg");
  });
});

describe("collectImageRefs", () => {
  it("maps original prop strings (relative+absolute) to absolute URLs", () => {
    const blocks = [
      block({ image: "/arquivos/ids/1", nested: { items: [{ src: "/img/b.png" }, { src: "https://cdn.com/c.webp" }] } }),
      block({ label: "hello", link: "/page" }),
      block(null),
    ];
    expect(collectImageRefs(blocks, "https://loja.com")).toEqual({
      "/arquivos/ids/1": "https://loja.com/arquivos/ids/1",
      "/img/b.png": "https://loja.com/img/b.png",
      "https://cdn.com/c.webp": "https://cdn.com/c.webp",
    });
  });
});

describe("rewriteBlockUrls", () => {
  it("swaps original refs for the resolved absolute URLs, deep + immutable", () => {
    const blocks = [block({ image: "/arquivos/ids/1", arr: ["/img/b.png", "keep"] })];
    const out = rewriteBlockUrls(blocks, {
      "/arquivos/ids/1": "https://loja.com/arquivos/ids/1",
      "/img/b.png": "https://loja.com/img/b.png",
    });
    expect(out[0]!.props).toEqual({
      image: "https://loja.com/arquivos/ids/1",
      arr: ["https://loja.com/img/b.png", "keep"],
    });
    expect(blocks[0]!.props!.image).toBe("/arquivos/ids/1"); // original untouched
  });
});

describe("countContentImages", () => {
  it("counts distinct absolute image URLs in props", () => {
    const blocks = [
      block({ a: "https://cdn.com/x.jpg", b: "https://cdn.com/x.jpg" }),
      block({ c: "https://loja.vtexassets.com/arquivos/ids/9", d: "/still/relative.png" }),
    ];
    expect(countContentImages(blocks)).toBe(2);
  });
});

describe("contentImageName", () => {
  it("derives a safe basename and dedupes collisions", () => {
    const used = new Set<string>();
    expect(contentImageName("https://cdn.com/path/banner.jpg?v=2", 0, used)).toBe("banner.jpg");
    expect(contentImageName("https://other.com/banner.jpg", 1, used)).toBe("1-banner.jpg");
    expect(contentImageName("https://cdn.com/arquivos/ids/999", 2, used)).toMatch(/\.img$/);
  });
});
