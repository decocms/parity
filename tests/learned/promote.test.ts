import { describe, expect, it } from "vitest";
import { promoteStepsFromFlow } from "../../src/learned/promote.ts";
import { type LearnedSelectors, getLearnedSelectors } from "../../src/learned/repo.ts";
import type { FlowCapture, StepCapture } from "../../src/types/schema.ts";

function emptyLib(): LearnedSelectors {
  return { schemaVersion: "0.1", platforms: {} };
}

function step(over: Partial<StepCapture>): StepCapture {
  return {
    name: "add-to-cart",
    status: "ok",
    durationMs: 100,
    ...over,
  } as StepCapture;
}

function flow(steps: StepCapture[]): FlowCapture {
  return { flow: "purchase-journey", side: "prod", viewport: "mobile", steps } as FlowCapture;
}

describe("promoteStepsFromFlow", () => {
  it("promotes LLM-recovered selectors only from OK steps", () => {
    const lib = emptyLib();
    const result = promoteStepsFromFlow(
      lib,
      "vtex",
      "x.com",
      flow([
        step({
          selectorKey: "buyButton",
          usedSelector: ".llm-ok",
          recoveredByLlm: true,
          status: "ok",
        }),
      ]),
    );
    expect(result.promoted).toBe(1);
    const entry = getLearnedSelectors(lib, "vtex", "buyButton")[0];
    expect(entry?.selector).toBe(".llm-ok");
    expect(entry?.origin).toBe("llm-guess");
  });

  it("does NOT promote an LLM-recovered selector from a FAILED step", () => {
    const lib = emptyLib();
    const result = promoteStepsFromFlow(
      lib,
      "vtex",
      "x.com",
      flow([
        step({
          selectorKey: "buyButton",
          usedSelector: ".llm-failed",
          recoveredByLlm: true,
          status: "failed",
        }),
      ]),
    );
    expect(result.promoted).toBe(0);
    expect(getLearnedSelectors(lib, "vtex", "buyButton")).toHaveLength(0);
  });

  it("records plain OK steps as verified", () => {
    const lib = emptyLib();
    promoteStepsFromFlow(
      lib,
      "vtex",
      "x.com",
      flow([step({ selectorKey: "buyButton", usedSelector: ".plain", status: "ok" })]),
    );
    const entry = getLearnedSelectors(lib, "vtex", "buyButton")[0];
    expect(entry?.origin).toBe("verified");
    expect(entry?.successRate).toBe(1);
  });

  it("skips composite selectors", () => {
    const lib = emptyLib();
    const result = promoteStepsFromFlow(
      lib,
      "vtex",
      "x.com",
      flow([step({ selectorKey: "buyButton", usedSelector: "input[x] → +", status: "ok" })]),
    );
    expect(result.recorded).toBe(0);
    expect(getLearnedSelectors(lib, "vtex", "buyButton")).toHaveLength(0);
  });
});
