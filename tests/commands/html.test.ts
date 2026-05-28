import { describe, expect, it, vi } from "vitest";
import { extractSelector, parseViewport, resolveMode } from "../../src/commands/html.ts";

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

describe("resolveMode", () => {
  const base = { viewport: "mobile", wait: "0" };

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

  it("warning quando seletor casa múltiplos (usa o primeiro)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = extractSelector(HTML, ".x");
    expect(r.warning).toMatch(/casou 2/);
    expect(r.html).toContain("hi");
    expect(r.html).not.toContain("there");
    spy.mockRestore();
  });
});
