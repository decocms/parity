import { describe, expect, it } from "vitest";
import { serverFnHoverFlood } from "../../src/checks/serverfn-hover-flood.ts";
import type { FlowCapture, StepCapture } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";

function hoverStep(
  side: "prod" | "cand",
  status: StepCapture["status"],
  serverFnRequestCount?: number,
): StepCapture {
  return {
    step: 4,
    name: "hover-preload-budget",
    side,
    viewport: "mobile",
    status,
    durationMs: 100,
    screenshotPath: "",
    detail:
      serverFnRequestCount !== undefined
        ? { hoveredCount: 8, serverFnRequestCount, pattern: "_serverFn" }
        : undefined,
  };
}

function plpFlow(side: "prod" | "cand", steps: StepCapture[]): FlowCapture {
  return {
    flow: "plp",
    side,
    viewport: "mobile",
    pages: [],
    steps,
    totalDurationMs: 1000,
  };
}

describe("serverFnHoverFlood", () => {
  it("skips when the plp flow didn't run at all", () => {
    const r = serverFnHoverFlood(makeContext());
    expect(r.status).toBe("skipped");
  });

  it("skips (no crash) when the step never collected data (e.g. Fresh prod, no product cards)", () => {
    const r = serverFnHoverFlood(
      makeContext({
        prodFlows: [plpFlow("prod", [hoverStep("prod", "skipped")])],
      }),
    );
    expect(r.status).toBe("skipped");
  });

  it("passes when the server-fn count is within the default budget", () => {
    const r = serverFnHoverFlood(
      makeContext({
        candFlows: [plpFlow("cand", [hoverStep("cand", "ok", 4)])],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues.length).toBe(0);
  });

  it("passes on a Fresh-style prod site where the pattern never matches (count=0)", () => {
    const r = serverFnHoverFlood(
      makeContext({
        prodFlows: [plpFlow("prod", [hoverStep("prod", "ok", 0)])],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues.length).toBe(0);
  });

  it("warns (high severity) when the count exceeds the default budget", () => {
    const r = serverFnHoverFlood(
      makeContext({
        candFlows: [plpFlow("cand", [hoverStep("cand", "ok", 32)])],
      }),
    );
    expect(r.status).toBe("warn");
    expect(r.issues[0]?.severity).toBe("high");
  });

  it("respects a custom rc.serverFnFloodBudget", () => {
    const r = serverFnHoverFlood(
      makeContext({
        rc: { serverFnFloodBudget: 3 },
        candFlows: [plpFlow("cand", [hoverStep("cand", "ok", 4)])],
      }),
    );
    expect(r.status).toBe("warn");
  });
});
