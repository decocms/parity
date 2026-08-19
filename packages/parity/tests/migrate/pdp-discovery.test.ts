import { describe, expect, it } from "vitest";
import { firstProductHref } from "../../src/migrate/pdp-discovery.ts";

describe("firstProductHref", () => {
  it("finds VTEX /p product links", () => {
    const html = `<a href="/institucional/sobre">x</a><a href="/camiseta-azul/p">buy</a>`;
    expect(firstProductHref(html, "https://loja.com", "vtex")).toBe("https://loja.com/camiseta-azul/p");
  });

  it("finds Shopify /products/ links", () => {
    const html = `<a href="/collections/all">x</a><a href="/products/tshirt-blue">buy</a>`;
    expect(firstProductHref(html, "https://loja.com", "shopify")).toBe(
      "https://loja.com/products/tshirt-blue",
    );
  });

  it("finds Salesforce Commerce .html product pages (issue #200)", () => {
    const html = `
      <a href="/maquiagem/">categoria</a>
      <a href="/logo.gif">logo</a>
      <a href="/batom-vermelho-matte-P4501.html">produto</a>
    `;
    expect(firstProductHref(html, "https://www.sephora.com.br", "salesforce-commerce")).toBe(
      "https://www.sephora.com.br/batom-vermelho-matte-P4501.html",
    );
  });

  it("finds Salesforce Product-Show controller links", () => {
    const html = `<a href="/on/demandware.store/Sites-X/pt_BR/Product-Show?pid=ABC123">ver</a>`;
    expect(firstProductHref(html, "https://loja.com", "salesforce-commerce")).toBe(
      "https://loja.com/on/demandware.store/Sites-X/pt_BR/Product-Show?pid=ABC123",
    );
  });

  it("rejects action endpoints (Wishlist-Add?pid=) and picks the real product (#200)", () => {
    // The wishlist link appears first but must NOT be treated as a PDP.
    const html = `
      <a href="/on/demandware.store/Sites-X/pt_BR/Wishlist-Add?pid=745696&source=productdetail">wishlist</a>
      <a href="/batom-vermelho-matte-P4501.html">produto</a>
    `;
    expect(firstProductHref(html, "https://loja.com", "salesforce-commerce")).toBe(
      "https://loja.com/batom-vermelho-matte-P4501.html",
    );
  });

  it("does not treat a plain .html page as a product without a pid shape", () => {
    const html = `<a href="/sobre-nos.html">sobre</a>`;
    expect(firstProductHref(html, "https://loja.com", "salesforce-commerce")).toBeNull();
  });

  it("falls back to the shared VTEX/Shopify heuristic for unknown platforms", () => {
    const html = `<a href="/produto/x/p">buy</a>`;
    expect(firstProductHref(html, "https://loja.com", "custom")).toBe("https://loja.com/produto/x/p");
  });
});
