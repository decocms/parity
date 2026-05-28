import { describe, expect, it } from "vitest";
import {
  extractSelector,
  parseViewport,
  parseWaitMs,
  resolveMode,
} from "../../src/commands/html.ts";

describe("parseViewport", () => {
  it("aceita os 3 viewports válidos", () => {
    expect(parseViewport("mobile")).toBe("mobile");
    expect(parseViewport("desktop")).toBe("desktop");
    expect(parseViewport("tablet")).toBe("tablet");
  });

  it("retorna null para o resto", () => {
    expect(parseViewport("phone")).toBeNull();
    expect(parseViewport("")).toBeNull();
  });
});

describe("parseWaitMs (cubic #2 — strict integer parsing)", () => {
  it("aceita string de inteiro positivo", () => {
    expect(parseWaitMs("0")).toBe(0);
    expect(parseWaitMs("2000")).toBe(2000);
  });

  it("aceita number direto vindo do commander coercer", () => {
    expect(parseWaitMs(2000)).toBe(2000);
    expect(parseWaitMs(0)).toBe(0);
  });

  it("REJEITA '5abc' (Number.parseInt antigamente truncava silenciosamente)", () => {
    expect(parseWaitMs("5abc")).toBeNull();
    expect(parseWaitMs("abc")).toBeNull();
    expect(parseWaitMs("5.5")).toBeNull();
    expect(parseWaitMs("-1")).toBeNull();
  });

  it("rejeita NaN, Infinity, números fracionários e negativos", () => {
    expect(parseWaitMs(Number.NaN)).toBeNull();
    expect(parseWaitMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseWaitMs(-100)).toBeNull();
    expect(parseWaitMs(1.5)).toBeNull();
  });

  it("rejeita undefined / tipos não suportados", () => {
    expect(parseWaitMs(undefined)).toBeNull();
    expect(parseWaitMs("")).toBeNull();
  });
});

describe("resolveMode", () => {
  const base = { viewport: "mobile", wait: 0 };

  it("single mode: só --url presente", () => {
    const r = resolveMode({ ...base, url: "https://x.com/" });
    expect(r).toEqual({ kind: "single", url: "https://x.com/" });
  });

  it("diff mode: --prod + --cand + --diff", () => {
    const r = resolveMode({
      ...base,
      prod: "https://p.com/",
      cand: "https://c.com/",
      diff: true,
    });
    expect(r).toEqual({ kind: "diff", prod: "https://p.com/", cand: "https://c.com/" });
  });

  it("erro: --url junto com --prod/--cand", () => {
    const r = resolveMode({
      ...base,
      url: "https://x.com/",
      prod: "https://p.com/",
      cand: "https://c.com/",
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/SOZINHO/);
  });

  it("erro: --prod sem --cand", () => {
    const r = resolveMode({ ...base, prod: "https://p.com/" });
    expect(r.kind).toBe("error");
  });

  it("erro: --prod + --cand SEM --diff", () => {
    const r = resolveMode({ ...base, prod: "https://p.com/", cand: "https://c.com/" });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/--diff/);
  });

  it("erro: --url inválido", () => {
    const r = resolveMode({ ...base, url: "not-a-url" });
    expect(r.kind).toBe("error");
  });

  it("erro: nada passado", () => {
    const r = resolveMode(base);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/modo não definido/);
  });
});

describe("extractSelector", () => {
  const HTML = `<html><body><header id="h"><nav>menu</nav></header><main><p class="x">hi</p><p class="x">there</p></main></body></html>`;

  it("retorna doc inteiro quando selector é undefined", () => {
    const r = extractSelector(HTML, undefined);
    expect(r.error).toBeUndefined();
    expect(r.html).toContain("<header");
  });

  it("retorna outer HTML de um match", () => {
    const r = extractSelector(HTML, "#h");
    expect(r.error).toBeUndefined();
    expect(r.html).toMatch(/<header[^>]*>.*<\/header>/);
    expect(r.html).toContain("menu");
  });

  it("erro quando seletor não casa nada", () => {
    const r = extractSelector(HTML, "#no-such-id");
    expect(r.error).toMatch(/não casou/);
  });

  it("cubic #3: warning é retornado mas extractSelector é PURA (sem side effect de console.error)", () => {
    // O caller é responsável por imprimir; aqui só verificamos que a função
    // não chama console.error.
    let stderrCalls = 0;
    const orig = console.error;
    console.error = () => {
      stderrCalls++;
    };
    try {
      const r = extractSelector(HTML, ".x");
      expect(r.warning).toMatch(/casou 2/);
      expect(r.html).toContain("hi");
      expect(r.html).not.toContain("there");
      expect(stderrCalls).toBe(0);
    } finally {
      console.error = orig;
    }
  });
});
