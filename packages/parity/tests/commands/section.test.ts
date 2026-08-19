import { describe, expect, it } from "vitest";
import { type SideData, hashSelector, parseViewport, verdict } from "../../src/commands/section.ts";
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

describe("verdict() — cubic #2 fix", () => {
  function makeSide(over: Partial<SideData>): SideData {
    return { html: null, styles: null, screenshotTaken: false, ...over };
  }
  const stylesObj = Object.fromEntries(SECTION_STYLE_KEYS.map((k) => [k, "0px"]));

  it("retorna 0 quando html, styles, hidden e rect coincidem", () => {
    const styles = {
      found: true as const,
      styles: stylesObj,
      rect: { x: 0, y: 0, width: 100, height: 50 },
      hiddenByPlaywright: false,
    };
    const p = makeSide({ html: "<h>x</h>", styles });
    const c = makeSide({ html: "<h>x</h>", styles: { ...styles } });
    expect(verdict(p, c)).toBe(0);
  });

  it("retorna 1 quando boundingRect.width difere (cubic #2 — antes retornava 0)", () => {
    const prodStyles = {
      found: true as const,
      styles: stylesObj,
      rect: { x: 0, y: 0, width: 100, height: 50 },
      hiddenByPlaywright: false,
    };
    const candStyles = {
      ...prodStyles,
      rect: { x: 0, y: 0, width: 300, height: 50 },
    };
    const p = makeSide({ html: "<h>x</h>", styles: prodStyles });
    const c = makeSide({ html: "<h>x</h>", styles: candStyles });
    expect(verdict(p, c)).toBe(1);
  });

  it("retorna 1 quando boundingRect.height difere", () => {
    const prodStyles = {
      found: true as const,
      styles: stylesObj,
      rect: { x: 0, y: 0, width: 100, height: 50 },
      hiddenByPlaywright: false,
    };
    const candStyles = {
      ...prodStyles,
      rect: { x: 0, y: 0, width: 100, height: 300 },
    };
    const p = makeSide({ html: "<h>x</h>", styles: prodStyles });
    const c = makeSide({ html: "<h>x</h>", styles: candStyles });
    expect(verdict(p, c)).toBe(1);
  });

  it("retorna 1 quando um lado tem htmlError", () => {
    const p = makeSide({ htmlError: "selector não casou" });
    const c = makeSide({ html: "<h>x</h>" });
    expect(verdict(p, c)).toBe(1);
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
