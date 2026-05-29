import { describe, expect, it } from "vitest";
import { searchResults } from "../../src/checks/search-results.ts";
import type { FlowCapture, StepCapture } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";

function resultsStep(side: "prod" | "cand", resultCount: number): StepCapture {
  return {
    step: 4,
    name: "submit-results",
    side,
    viewport: "mobile",
    status: "ok",
    durationMs: 100,
    screenshotPath: "",
    searchValidation: {
      term: "camisa",
      mode: "results",
      resultCount,
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

describe("searchResults", () => {
  it("passa quando counts batem dentro de ±30%", () => {
    const r = searchResults(
      makeContext({
        prodFlows: [flow("prod", resultsStep("prod", 20))],
        candFlows: [flow("cand", resultsStep("cand", 22))],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("high quando delta >30%", () => {
    const r = searchResults(
      makeContext({
        prodFlows: [flow("prod", resultsStep("prod", 100))],
        candFlows: [flow("cand", resultsStep("cand", 50))],
      }),
    );
    expect(r.issues.some((i) => i.severity === "high")).toBe(true);
  });

  it("critical quando cand zerou e prod tinha resultados", () => {
    const r = searchResults(
      makeContext({
        prodFlows: [flow("prod", resultsStep("prod", 20))],
        candFlows: [flow("cand", resultsStep("cand", 0))],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("single-site: high quando busca não retorna produtos", () => {
    const r = searchResults(
      makeContext({
        candFlows: [flow("cand", resultsStep("cand", 0))],
      }),
    );
    expect(r.issues.some((i) => i.severity === "high")).toBe(true);
  });
});
