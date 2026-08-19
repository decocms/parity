import { describe, expect, it } from "vitest";
import { searchAutocomplete } from "../../src/checks/search-autocomplete.ts";
import type { FlowCapture, StepCapture } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";

function autocompleteStep(side: "prod" | "cand", suggestionCount: number): StepCapture {
  return {
    step: 3,
    name: "type-and-autocomplete",
    side,
    viewport: "mobile",
    status: "ok",
    durationMs: 100,
    screenshotPath: "",
    searchValidation: {
      term: "camisa",
      mode: "autocomplete",
      suggestionCount,
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

describe("searchAutocomplete", () => {
  it("passa quando ambos têm autocomplete com sugestões", () => {
    const r = searchAutocomplete(
      makeContext({
        prodFlows: [flow("prod", autocompleteStep("prod", 5))],
        candFlows: [flow("cand", autocompleteStep("cand", 6))],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("high quando prod tem autocomplete e cand tem 0", () => {
    const r = searchAutocomplete(
      makeContext({
        prodFlows: [flow("prod", autocompleteStep("prod", 5))],
        candFlows: [flow("cand", autocompleteStep("cand", 0))],
      }),
    );
    expect(r.issues.some((i) => i.severity === "high")).toBe(true);
  });

  it("medium quando count diverge >50%", () => {
    const r = searchAutocomplete(
      makeContext({
        prodFlows: [flow("prod", autocompleteStep("prod", 10))],
        candFlows: [flow("cand", autocompleteStep("cand", 3))],
      }),
    );
    expect(r.issues.some((i) => i.severity === "medium")).toBe(true);
  });

  it("single-site: medium quando autocomplete não retornou sugestões", () => {
    const r = searchAutocomplete(
      makeContext({
        candFlows: [flow("cand", autocompleteStep("cand", 0))],
      }),
    );
    expect(r.issues.some((i) => i.severity === "medium")).toBe(true);
  });
});
