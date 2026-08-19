import { describe, expect, it } from "vitest";
import {
  ALL_CHECKS,
  ALL_CHECKS_BY_NAME,
  FLOW_DEPENDENT_CHECKS,
  getCheckByName,
} from "../../src/checks/index.ts";

describe("checks registry (used by parity check)", () => {
  it("ALL_CHECKS_BY_NAME tem entrada pra cada função em ALL_CHECKS", () => {
    // Garante que o map manual não fica desincronizado com o array.
    const mapped = new Set(Object.values(ALL_CHECKS_BY_NAME));
    for (const fn of ALL_CHECKS) {
      expect(mapped.has(fn)).toBe(true);
    }
    expect(mapped.size).toBe(ALL_CHECKS.length);
  });

  it("cubic #1: name → function pairing está correto (não só values overlap)", async () => {
    // O teste anterior aceitava swap/dup: se 'name-a' e 'name-b'
    // apontassem pra mesma função, o teste de "values match" passava
    // mas o dispatch do `parity check` quebrava. Aqui chamamos cada
    // entrada com um ctx mínimo e conferimos que `result.name` volta
    // igual à chave do registry.
    const minimalCtx = {
      prodPages: [],
      candPages: [],
      prodFlows: [],
      candFlows: [],
      rc: { cep: "01310-100", selectors: {}, skipSteps: [] },
      ignore: {
        ignoreSelectorsVisual: [],
        ignoreRequestPatterns: [],
        ignoreConsolePatterns: [],
        ignoreMetaKeys: [],
        toleratedDomDrift: {},
      },
      outDir: "/tmp",
      viewports: ["mobile" as const],
    };
    for (const [registeredName, fn] of Object.entries(ALL_CHECKS_BY_NAME)) {
      const result = await fn(minimalCtx);
      expect(result.name).toBe(registeredName);
    }
  });

  it("cubic #2: getCheckByName ignora prototype keys (__proto__, toString, constructor)", () => {
    expect(getCheckByName("__proto__")).toBeUndefined();
    expect(getCheckByName("toString")).toBeUndefined();
    expect(getCheckByName("constructor")).toBeUndefined();
    expect(getCheckByName("hasOwnProperty")).toBeUndefined();
    // E ainda resolve nomes reais.
    expect(getCheckByName("console-errors-baseline")).toBeDefined();
  });

  it("todos os nomes são kebab-case (sem espaços, lowercase)", () => {
    for (const name of Object.keys(ALL_CHECKS_BY_NAME)) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("FLOW_DEPENDENT_CHECKS aponta para nomes existentes em ALL_CHECKS_BY_NAME", () => {
    for (const name of FLOW_DEPENDENT_CHECKS) {
      expect(ALL_CHECKS_BY_NAME[name]).toBeDefined();
    }
  });

  it("inclui pelo menos os 14 checks conhecidos", () => {
    const expected = [
      "http-status-parity",
      "console-errors-baseline",
      "html-structural-diff",
      "meta-seo-parity",
      "visual-regression-keyframes",
      "purchase-journey-flow",
      "network-summary-delta",
      "web-vitals-mobile",
      "image-loading-health",
      "banner-aspect-ratio",
      "cart-reveal-mode-divergence",
      "lazy-section-presence",
      "seo-deep-audit",
      "cache-coverage",
    ];
    for (const name of expected) {
      expect(ALL_CHECKS_BY_NAME[name]).toBeDefined();
    }
  });

  it("FLOW_DEPENDENT_CHECKS contém purchase-journey-flow e cart-reveal-mode-divergence", () => {
    expect(FLOW_DEPENDENT_CHECKS.has("purchase-journey-flow")).toBe(true);
    expect(FLOW_DEPENDENT_CHECKS.has("cart-reveal-mode-divergence")).toBe(true);
  });

  it("checks NON-flow não estão em FLOW_DEPENDENT_CHECKS", () => {
    // Sanity: não devemos bloquear checks que rodam só com pageCaptures.
    const safe = ["console-errors-baseline", "http-status-parity", "banner-aspect-ratio"];
    for (const name of safe) {
      expect(FLOW_DEPENDENT_CHECKS.has(name)).toBe(false);
    }
  });
});
