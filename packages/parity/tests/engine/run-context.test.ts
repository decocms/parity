import { describe, expect, it } from "vitest";
import { detectRunCaveats } from "../../src/engine/run-context.ts";
import type { PageCapture } from "../../src/types/schema.ts";

function page(url: string, pairKey?: string): PageCapture {
  return { url, finalUrl: url, ...(pairKey ? { pairKey } : {}) } as unknown as PageCapture;
}

const clean = {
  prodUrl: "https://prod.example",
  candUrl: "https://cand.example",
  prodPages: [page("https://prod.example/")],
  candPages: [page("https://cand.example/")],
  verdict: { checksRun: 10, checksSkipped: 0 },
  llmEnabled: true,
};

function ids(input: Parameters<typeof detectRunCaveats>[0]): string[] {
  return detectRunCaveats(input).map((c) => c.id);
}

describe("detectRunCaveats (#292)", () => {
  it("says nothing about a run with nothing worth saying", () => {
    expect(detectRunCaveats(clean)).toEqual([]);
  });

  it("flags a localhost candidate as a dev server", () => {
    const out = detectRunCaveats({ ...clean, candUrl: "http://localhost:3000" });
    expect(out.map((c) => c.id)).toEqual(["cand-dev-server"]);
    expect(out[0]?.level).toBe("warn");
    expect(out[0]?.detail).toContain("build de produção");
  });

  it("flags a localhost reference separately from a localhost candidate", () => {
    expect(
      ids({ ...clean, prodUrl: "http://127.0.0.1:8080", candUrl: "http://localhost:3000" }),
    ).toEqual(["cand-dev-server", "prod-dev-server"]);
  });

  it("flags paired pages that live at different paths", () => {
    const out = detectRunCaveats({
      ...clean,
      prodPages: [page("https://prod.example/encimera-abc/p", "pdp")],
      candPages: [page("https://cand.example/geladeira-xyz/p", "pdp")],
    });
    expect(out.map((c) => c.id)).toEqual(["paths-differ"]);
    expect(out[0]?.summary).toContain("1 página");
    expect(out[0]?.detail).toContain("/encimera-abc/p → /geladeira-xyz/p");
  });

  it("does not flag paired pages that share a path", () => {
    expect(
      ids({
        ...clean,
        prodPages: [page("https://prod.example/x/p", "pdp")],
        candPages: [page("https://cand.example/x/p", "pdp")],
      }),
    ).toEqual([]);
  });

  it("ignores unpaired captures — an orphan is not a path mismatch", () => {
    expect(
      ids({
        ...clean,
        prodPages: [page("https://prod.example/a")],
        candPages: [page("https://cand.example/b")],
      }),
    ).toEqual([]);
  });

  it("says LLM-dependent modules did not run, so no visual findings is not parity", () => {
    const out = detectRunCaveats({ ...clean, llmEnabled: false });
    expect(out.map((c) => c.id)).toEqual(["llm-disabled"]);
    expect(out[0]?.detail).toContain("não significa paridade visual");
  });

  it("states skipped checks, because a skipped check is not a passing one", () => {
    const out = detectRunCaveats({
      ...clean,
      verdict: { checksRun: 34, checksSkipped: 13 },
    });
    expect(out[0]?.summary).toBe("13 de 34 checks pulados");
  });

  it("carries the partial-run reason into the same banner", () => {
    const out = detectRunCaveats({ ...clean, partial: true, partialReason: "timeout during collect" });
    expect(out.map((c) => c.id)).toEqual(["partial-run"]);
    expect(out[0]?.detail).toContain("timeout during collect");
  });

  it("reports every applicable caveat, not just the first", () => {
    expect(
      ids({
        ...clean,
        candUrl: "http://localhost:3000",
        llmEnabled: false,
        verdict: { checksRun: 34, checksSkipped: 13 },
        partial: true,
      }),
    ).toEqual(["cand-dev-server", "llm-disabled", "checks-skipped", "partial-run"]);
  });

  it("survives an unparseable URL instead of throwing", () => {
    expect(() => detectRunCaveats({ ...clean, candUrl: "not a url" })).not.toThrow();
  });
});
