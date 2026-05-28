import { describe, expect, it } from "vitest";
import { hashSelector, parseViewport } from "../../src/commands/section.ts";
import { SECTION_STYLE_KEYS } from "../../src/engine/computed-styles.ts";

describe("parseViewport (section)", () => {
  it("aceita 3 viewports e rejeita o resto", () => {
    expect(parseViewport("mobile")).toBe("mobile");
    expect(parseViewport("desktop")).toBe("desktop");
    expect(parseViewport("tablet")).toBe("tablet");
    expect(parseViewport("phone")).toBeNull();
    expect(parseViewport("")).toBeNull();
  });
});

describe("hashSelector", () => {
  it("retorna 8 chars hex pra qualquer string", () => {
    const h = hashSelector("[data-section='Carousel']");
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it("é estável (mesma entrada → mesma saída)", () => {
    const a = hashSelector("#x");
    const b = hashSelector("#x");
    expect(a).toBe(b);
  });

  it("seletores diferentes produzem hashes diferentes", () => {
    const a = hashSelector("#a");
    const b = hashSelector("#b");
    expect(a).not.toBe(b);
  });
});

describe("SECTION_STYLE_KEYS contract", () => {
  it("inclui as keys de visibilidade que o caso miess-01 motivou", () => {
    // O reporter da issue #31 cita z-index, opacity, transform como
    // necessários pra detectar 'in DOM but invisible'. Esse teste pinba
    // a presença pra que ninguém remova sem perceber.
    expect(SECTION_STYLE_KEYS).toContain("z-index");
    expect(SECTION_STYLE_KEYS).toContain("opacity");
    expect(SECTION_STYLE_KEYS).toContain("transform");
    expect(SECTION_STYLE_KEYS).toContain("display");
    expect(SECTION_STYLE_KEYS).toContain("visibility");
  });

  it("não tem duplicatas", () => {
    const set = new Set(SECTION_STYLE_KEYS);
    expect(set.size).toBe(SECTION_STYLE_KEYS.length);
  });

  it("todas as keys são strings não-vazias", () => {
    for (const k of SECTION_STYLE_KEYS) {
      expect(typeof k).toBe("string");
      expect(k.length).toBeGreaterThan(0);
    }
  });
});
