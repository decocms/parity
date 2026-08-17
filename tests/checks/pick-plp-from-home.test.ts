import { describe, expect, it } from "vitest";
import { pickPlpFromHomeHtml } from "../../src/checks/plp-pagination.ts";

describe("pickPlpFromHomeHtml", () => {
  it("picks the shortest category-looking path, absolutized", () => {
    const html = `
      <a href="/">home</a>
      <a href="https://external.com/x">ext</a>
      <a href="/p/some-product-123/p">produto</a>
      <a href="/institucional/sobre/empresa/extra">deep</a>
      <a href="/maquiagem">categoria</a>
      <a href="/cart">carrinho</a>
    `;
    expect(pickPlpFromHomeHtml(html, "https://loja.com")).toBe("https://loja.com/maquiagem");
  });

  it("returns null when no category href exists", () => {
    const html = `<a href="/">home</a><a href="/cart">cart</a><a href="/p/x/p">pdp</a>`;
    expect(pickPlpFromHomeHtml(html, "https://loja.com")).toBeNull();
  });

  it("skips asset and login/account links", () => {
    const html = `<a href="/logo.svg">l</a><a href="/login">in</a><a href="/eletronicos">cat</a>`;
    expect(pickPlpFromHomeHtml(html, "https://loja.com")).toBe("https://loja.com/eletronicos");
  });
});
