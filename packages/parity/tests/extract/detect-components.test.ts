import { describe, expect, it } from "vitest";
import {
  type RawCandidate,
  boxArea,
  boxOverlapArea,
  canonicalRole,
  containmentRatio,
  dedupeByContainment,
  isStructuralJunkRole,
  sanitizeDetectedComponents,
} from "../../src/extract/detect-components.ts";
import type { DetectedComponent } from "../../src/types/extract.ts";

function candidate(over: Partial<RawCandidate>): RawCandidate {
  return {
    role: "section",
    selector: ".x",
    rect: { x: 0, y: 0, width: 100, height: 100 },
    priority: 30,
    ...over,
  };
}

describe("boxArea", () => {
  it("computa largura x altura", () => {
    expect(boxArea({ x: 0, y: 0, width: 10, height: 20 })).toBe(200);
  });
  it("nunca é negativo", () => {
    expect(boxArea({ x: 0, y: 0, width: -5, height: 20 })).toBe(0);
  });
});

describe("boxOverlapArea / containmentRatio", () => {
  it("retorna 0 quando as caixas não se sobrepõem", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    const b = { x: 100, y: 100, width: 10, height: 10 };
    expect(boxOverlapArea(a, b)).toBe(0);
    expect(containmentRatio(a, b)).toBe(0);
  });

  it("containmentRatio = 1 quando inner está totalmente dentro de outer", () => {
    const inner = { x: 10, y: 10, width: 20, height: 20 };
    const outer = { x: 0, y: 0, width: 100, height: 100 };
    expect(containmentRatio(inner, outer)).toBe(1);
  });

  it("containmentRatio parcial quando as caixas se sobrepõem parcialmente", () => {
    const inner = { x: 0, y: 0, width: 10, height: 10 }; // area 100
    const outer = { x: 5, y: 5, width: 10, height: 10 }; // overlap 5x5=25
    expect(containmentRatio(inner, outer)).toBeCloseTo(0.25, 5);
  });

  it("retorna 0 quando inner tem área zero", () => {
    const inner = { x: 0, y: 0, width: 0, height: 10 };
    const outer = { x: 0, y: 0, width: 100, height: 100 };
    expect(containmentRatio(inner, outer)).toBe(0);
  });
});

describe("dedupeByContainment", () => {
  it("descarta um nav totalmente contido no header (mesma prioridade/maior)", () => {
    const header = candidate({
      role: "header",
      selector: "header",
      rect: { x: 0, y: 0, width: 1000, height: 200 },
      priority: 100,
    });
    const nav = candidate({
      role: "nav",
      selector: "header nav",
      rect: { x: 100, y: 50, width: 200, height: 50 },
      priority: 60,
    });
    const out = dedupeByContainment([header, nav]);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("header");
  });

  it("mantém dois componentes do mesmo tamanho que não se sobrepõem (siblings genuínos)", () => {
    const a = candidate({
      role: "shelf",
      selector: "#a",
      rect: { x: 0, y: 0, width: 500, height: 300 },
      priority: 50,
    });
    const b = candidate({
      role: "shelf",
      selector: "#b",
      rect: { x: 0, y: 400, width: 500, height: 300 },
      priority: 50,
    });
    const out = dedupeByContainment([a, b]);
    expect(out).toHaveLength(2);
  });

  it("mantém um componente de prioridade maior mesmo contido num de prioridade menor", () => {
    const bigLowPriority = candidate({
      role: "section-generic",
      selector: ".generic",
      rect: { x: 0, y: 0, width: 1000, height: 1000 },
      priority: 30,
    });
    const minicart = candidate({
      role: "minicart",
      selector: "[data-minicart]",
      rect: { x: 800, y: 0, width: 100, height: 100 },
      priority: 90,
    });
    const out = dedupeByContainment([bigLowPriority, minicart]);
    expect(out.map((c) => c.role).sort()).toEqual(["minicart", "section-generic"]);
  });

  it("descarta caixas com área zero", () => {
    const zero = candidate({ rect: { x: 0, y: 0, width: 0, height: 0 } });
    const out = dedupeByContainment([zero]);
    expect(out).toHaveLength(0);
  });

  it("ordena o resultado por posição vertical (ordem de documento)", () => {
    const bottom = candidate({
      role: "footer",
      selector: "footer",
      rect: { x: 0, y: 900, width: 1000, height: 100 },
      priority: 100,
    });
    const top = candidate({
      role: "header",
      selector: "header",
      rect: { x: 0, y: 0, width: 1000, height: 100 },
      priority: 100,
    });
    const out = dedupeByContainment([bottom, top]);
    expect(out.map((c) => c.role)).toEqual(["header", "footer"]);
  });
});

describe("isStructuralJunkRole", () => {
  it.each([
    "main-wrapper",
    "main-container",
    "portal-root",
    "overlay-container",
    "modal-overlay",
    "modal-dialog",
    "page-content",
    "sticky-wrapper",
  ])("descarta o wrapper estrutural %s", (role) => {
    expect(isStructuralJunkRole(role)).toBe(true);
  });

  it.each([
    "header",
    "footer",
    "product-shelf",
    "newsletter-signup",
    "newsletter-modal",
    "registration-modal",
    "product-hero",
    "search-results",
    "section-deals",
    "shelf-freezers-launch",
  ])("mantém o componente de conteúdo %s", (role) => {
    expect(isStructuralJunkRole(role)).toBe(false);
  });
});

describe("canonicalRole", () => {
  it.each([
    ["site-header", "header"],
    ["header", "header"],
    ["site-footer", "footer"],
    ["footer-content", "footer"],
    ["navigation-menu", "nav"],
    ["main-navigation", "nav"],
    ["navigation-mega-menu", "nav"],
    ["nav", "nav"],
  ])("dobra %s → %s", (input, expected) => {
    expect(canonicalRole(input)).toBe(expected);
  });

  it.each(["product-hero", "product-shelf", "product-navigation", "newsletter-signup"])(
    "não dobra o componente de página %s",
    (role) => {
      expect(canonicalRole(role)).toBe(role);
    },
  );
});

describe("sanitizeDetectedComponents", () => {
  function comp(role: string, selector = `.${role}`): DetectedComponent {
    return { role, selector, boundingBox: { x: 0, y: 0, width: 100, height: 100 } };
  }

  it("limpa uma captura live-only realista (27 → sem lixo, globais únicos)", () => {
    // Nomes reais capturados de um site VTEX IO (www.electrolux.com.ec).
    const raw = [
      "main-wrapper",
      "header",
      "modal-overlay",
      "product-shelf",
      "footer",
      "search-results",
      "newsletter-signup",
      "product-combo-section",
      "notify-me-form",
      "product-carousel",
      "navigation-menu",
      "newsletter-signup-form",
      "modal-dialog",
      "overlay-container",
      "main-container",
      "shelf-freezers-launch",
      "product-detail-hero",
      "site-header",
      "newsletter-modal",
      "registration-modal",
      "site-footer",
      "product-hero",
      "product-slider",
      "main-navigation",
      "navigation-mega-menu",
      "portal-root",
      "footer-content",
    ].map((r) => comp(r));

    const out = sanitizeDetectedComponents(raw);
    const roles = out.map((c) => c.role);

    // Lixo estrutural some.
    for (const junk of [
      "main-wrapper",
      "main-container",
      "portal-root",
      "overlay-container",
      "modal-overlay",
      "modal-dialog",
    ]) {
      expect(roles).not.toContain(junk);
    }
    // Globais colapsam para uma ocorrência cada.
    expect(roles.filter((r) => r === "header")).toHaveLength(1);
    expect(roles.filter((r) => r === "footer")).toHaveLength(1);
    expect(roles.filter((r) => r === "nav")).toHaveLength(1);
    // Componentes de conteúdo reais sobrevivem.
    for (const kept of ["product-shelf", "search-results", "newsletter-modal", "product-hero"]) {
      expect(roles).toContain(kept);
    }
    expect(out.length).toBeLessThan(raw.length);
  });

  it("preserva o primeiro seletor ao colapsar globais", () => {
    const out = sanitizeDetectedComponents([
      comp("header", "header#top"),
      comp("site-header", ".masthead"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.selector).toBe("header#top");
    expect(out[0]?.role).toBe("header");
  });
});
