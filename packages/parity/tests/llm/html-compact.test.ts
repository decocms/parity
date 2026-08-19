import { describe, expect, it } from "vitest";
import {
  compactHtmlForSelectors,
  computeHtmlFingerprint,
  isSemanticClassToken,
} from "../../src/llm/html-compact.ts";

describe("isSemanticClassToken", () => {
  it("keeps semantic and platform-prefixed tokens", () => {
    for (const t of ["card", "product-card", "vtex-minicart", "fs-cart", "nav-item"]) {
      expect(isSemanticClassToken(t), t).toBe(true);
    }
  });

  it("drops Tailwind utility tokens", () => {
    for (const t of [
      "w-full",
      "h-12",
      "lg:text-xs",
      "after:bg-no-repeat",
      "w-[198px]",
      "flex",
      "hidden",
      "px-5",
      "m2",
    ]) {
      expect(isSemanticClassToken(t), t).toBe(false);
    }
  });

  it("keeps semantic color tokens", () => {
    expect(isSemanticClassToken("text-primary")).toBe(true);
    expect(isSemanticClassToken("bg-brand")).toBe(true);
  });
});

describe("compactHtmlForSelectors", () => {
  it("keeps header/nav/forms/footer and drops scripts", () => {
    const html = `<html><head><script>x()</script></head><body>
      <header><nav><a href="/c/bolsas">Bolsas</a></nav></header>
      <form><input type="search" name="q"/></form>
      <footer><a href="/contato">Contato</a></footer>
    </body></html>`;
    const out = compactHtmlForSelectors(html);
    expect(out).toMatch(/<header/);
    expect(out).toMatch(/type="search"/);
    expect(out).toMatch(/<footer/);
    expect(out).not.toMatch(/<script/);
  });
});

describe("computeHtmlFingerprint", () => {
  const page = (products: string[]) => `<html><body>
    <header class="site-header w-full flex"><a aria-label="Sacola" href="/cart">🛒</a></header>
    <div data-product-list>
      ${products.map((p) => `<a class="product-card" href="/${p}/p">${p}</a>`).join("\n")}
    </div>
  </body></html>`;

  it("is stable across content rotation (different products, same structure)", () => {
    const a = computeHtmlFingerprint(page(["tenis-azul", "bolsa-preta"]));
    const b = computeHtmlFingerprint(page(["camiseta-branca", "mochila-verde", "bone-vermelho"]));
    expect(a).toBe(b);
  });

  it("changes when the structure/theme changes", () => {
    const a = computeHtmlFingerprint(page(["tenis-azul"]));
    const redesigned = `<html><body>
      <header class="new-navbar"><button data-minicart-trigger>Cart</button></header>
      <section class="shelf-v2"><article class="tile"><a href="/x/p">x</a></article></section>
    </body></html>`;
    const b = computeHtmlFingerprint(redesigned);
    expect(a).not.toBe(b);
  });

  it("ignores Tailwind utility class churn", () => {
    const a = computeHtmlFingerprint(
      `<div class="product-card w-full h-12 flex"><a href="/a/p">a</a></div>`,
    );
    const b = computeHtmlFingerprint(
      `<div class="product-card w-1/2 h-16 grid gap-2"><a href="/b/p">b</a></div>`,
    );
    expect(a).toBe(b);
  });

  it("does not throw on garbage input", () => {
    expect(typeof computeHtmlFingerprint("@@not html@@")).toBe("string");
    expect(computeHtmlFingerprint("")).toBeTypeOf("string");
  });
});
