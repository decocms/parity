import { describe, expect, it } from "vitest";
import { capLinks, parseBackgroundImageUrl } from "../../src/extract/extract-component.ts";

describe("parseBackgroundImageUrl", () => {
  it('extrai a URL de um valor url("...") simples', () => {
    expect(parseBackgroundImageUrl('url("https://x.com/a.png")')).toBe("https://x.com/a.png");
  });

  it("extrai a URL de um valor url(...) sem aspas", () => {
    expect(parseBackgroundImageUrl("url(https://x.com/a.png)")).toBe("https://x.com/a.png");
  });

  it("extrai a URL de um valor url('...') com aspas simples", () => {
    expect(parseBackgroundImageUrl("url('https://x.com/a.png')")).toBe("https://x.com/a.png");
  });

  it("pega apenas a primeira URL de uma lista separada por vírgula", () => {
    expect(parseBackgroundImageUrl('url("a.png"), url("b.png")')).toBe("a.png");
  });

  it("retorna null para 'none'", () => {
    expect(parseBackgroundImageUrl("none")).toBeNull();
  });

  it("retorna null para valores vazios/nulos/undefined", () => {
    expect(parseBackgroundImageUrl("")).toBeNull();
    expect(parseBackgroundImageUrl(null)).toBeNull();
    expect(parseBackgroundImageUrl(undefined)).toBeNull();
  });

  it("retorna null para um gradiente (não é url(...))", () => {
    expect(parseBackgroundImageUrl("linear-gradient(to right, red, blue)")).toBeNull();
  });
});

describe("capLinks", () => {
  it("não corta uma lista menor que o limite", () => {
    const links = [{ href: "/a", text: "a" }];
    expect(capLinks(links, 30)).toEqual(links);
  });

  it("corta no limite exato", () => {
    const links = Array.from({ length: 50 }, (_, i) => ({ href: `/${i}`, text: `${i}` }));
    const capped = capLinks(links, 30);
    expect(capped).toHaveLength(30);
    expect(capped[0]).toEqual({ href: "/0", text: "0" });
    expect(capped[29]).toEqual({ href: "/29", text: "29" });
  });

  it("não muta o array original", () => {
    const links = Array.from({ length: 5 }, (_, i) => ({ href: `/${i}`, text: `${i}` }));
    const capped = capLinks(links, 2);
    expect(links).toHaveLength(5);
    expect(capped).toHaveLength(2);
  });
});
