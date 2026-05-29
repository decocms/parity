import { describe, expect, it } from "vitest";
import { searchNoResults } from "../../src/checks/search-no-results.ts";
import type { FlowCapture, StepCapture } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";

function noResultsStep(
  side: "prod" | "cand",
  resultCount: number,
  hasEmptyState: boolean,
): StepCapture {
  return {
    step: 5,
    name: "search-no-results",
    side,
    viewport: "mobile",
    status: "ok",
    durationMs: 100,
    screenshotPath: "",
    searchValidation: {
      term: "zzqxxq-abc123",
      mode: "no-results",
      resultCount,
      hasEmptyState,
    },
  };
}

function flow(side: "prod" | "cand", step: StepCapture): FlowCapture {
  return {
    flow: "search",
    side,
    viewport: "mobile",
    pages: [],
    steps: [step],
    totalDurationMs: 1000,
  };
}

describe("searchNoResults", () => {
  it("passa quando ambos têm 0 resultados e empty state visível", () => {
    const r = searchNoResults(
      makeContext({
        prodFlows: [flow("prod", noResultsStep("prod", 0, true))],
        candFlows: [flow("cand", noResultsStep("cand", 0, true))],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("critical quando cand retorna MUITOS produtos para termo unicode sem empty state", () => {
    // > 10 produtos = "matcheia qualquer coisa" real
    const r = searchNoResults(
      makeContext({
        prodFlows: [flow("prod", noResultsStep("prod", 0, true))],
        candFlows: [flow("cand", noResultsStep("cand", 15, false))],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("medium quando cand retorna POUCOS produtos sem empty state (fuzzy fallback)", () => {
    // 1-10 produtos = fuzzy fallback do search engine (VTEX Intelligent Search comum)
    const r = searchNoResults(
      makeContext({
        prodFlows: [flow("prod", noResultsStep("prod", 0, true))],
        candFlows: [flow("cand", noResultsStep("cand", 3, false))],
      }),
    );
    expect(r.issues.some((i) => i.severity === "medium")).toBe(true);
    expect(r.issues.every((i) => i.severity !== "critical")).toBe(true);
  });

  it("NÃO marca crítico quando cand mostra produtos COM empty state (recommendations)", () => {
    // Padrão UX comum: 'Não encontramos X. Veja estas recomendações.' — não é bug.
    const r = searchNoResults(
      makeContext({
        prodFlows: [flow("prod", noResultsStep("prod", 0, true))],
        candFlows: [flow("cand", noResultsStep("cand", 8, true))],
      }),
    );
    expect(r.issues.every((i) => i.severity !== "critical")).toBe(true);
  });

  it("medium quando empty state ausente em cand", () => {
    const r = searchNoResults(
      makeContext({
        prodFlows: [flow("prod", noResultsStep("prod", 0, true))],
        candFlows: [flow("cand", noResultsStep("cand", 0, false))],
      }),
    );
    expect(r.issues.some((i) => i.severity === "medium")).toBe(true);
  });

  it("single-site: critical quando busca de unicode retorna >10 produtos sem empty state", () => {
    const r = searchNoResults(
      makeContext({
        candFlows: [flow("cand", noResultsStep("cand", 20, false))],
      }),
    );
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("single-site: medium (não critical) quando há 1-3 produtos (fuzzy fallback)", () => {
    // Caso real Miess/VTEX Intelligent Search — retorna 1 produto fuzzy mesmo pra unicode.
    const r = searchNoResults(
      makeContext({
        candFlows: [flow("cand", noResultsStep("cand", 1, false))],
      }),
    );
    expect(r.issues.some((i) => i.severity === "medium")).toBe(true);
    expect(r.issues.every((i) => i.severity !== "critical")).toBe(true);
  });

  it("single-site: NÃO marca crítico quando há produtos COM empty state visível (recommendations)", () => {
    // Lojas reais (Miess, VTEX padrão) mostram 'sem resultados' + carousel de recomendações.
    const r = searchNoResults(
      makeContext({
        candFlows: [flow("cand", noResultsStep("cand", 12, true))],
      }),
    );
    expect(r.issues.every((i) => i.severity !== "critical")).toBe(true);
  });
});
