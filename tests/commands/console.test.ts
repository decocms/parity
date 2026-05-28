import { describe, expect, it } from "vitest";
import { parseFilter, parseViewport } from "../../src/commands/console.ts";

describe("parseViewport", () => {
  it("aceita mobile, desktop e tablet", () => {
    expect(parseViewport("mobile")).toBe("mobile");
    expect(parseViewport("desktop")).toBe("desktop");
    expect(parseViewport("tablet")).toBe("tablet");
  });

  it("rejeita strings desconhecidas", () => {
    expect(parseViewport("phone")).toBeNull();
    expect(parseViewport("")).toBeNull();
    expect(parseViewport("MOBILE")).toBeNull();
  });
});

describe("parseFilter", () => {
  it("default é {error, warning}", () => {
    const r = parseFilter(undefined);
    expect(r).toEqual(new Set(["error", "warning"]));
  });

  it("aceita lista válida separada por vírgula com trim e case-insensitive", () => {
    const r = parseFilter(" ERROR , log, debug");
    expect(r).toEqual(new Set(["error", "log", "debug"]));
  });

  it("descarta tipos inválidos sem quebrar", () => {
    const r = parseFilter("error,nonsense,info");
    expect(r).toEqual(new Set(["error", "info"]));
  });

  it("cai pro default se nenhum tipo válido sobrar", () => {
    const r = parseFilter("nonsense,bogus");
    expect(r).toEqual(new Set(["error", "warning"]));
  });

  it("string vazia → default", () => {
    expect(parseFilter("")).toEqual(new Set(["error", "warning"]));
  });
});
