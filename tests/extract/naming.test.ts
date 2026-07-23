import { describe, expect, it } from "vitest";
import { componentDirName } from "../../src/extract/naming.ts";

describe("componentDirName", () => {
  it("junta role slugificado + índice", () => {
    expect(componentDirName("header", 1)).toBe("header-1");
  });

  it("slugifica espaços e caracteres não alfanuméricos", () => {
    expect(componentDirName("Hero Banner!", 2)).toBe("hero-banner-2");
  });

  it("colapsa hífens duplicados e remove nas bordas", () => {
    expect(componentDirName("--Shelf__Related--", 3)).toBe("shelf-related-3");
  });

  it("usa 'component' como fallback quando o role fica vazio após slugificar", () => {
    expect(componentDirName("!!!", 4)).toBe("component-4");
  });
});
