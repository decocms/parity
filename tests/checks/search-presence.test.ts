import { describe, expect, it } from "vitest";
import { searchPresence } from "../../src/checks/search-presence.ts";
import type { FlowCapture, StepCapture } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";

function step(name: string, status: StepCapture["status"], side: "prod" | "cand", note?: string): StepCapture {
  return {
    step: 2,
    name,
    side,
    viewport: "mobile",
    status,
    durationMs: 100,
    screenshotPath: "",
    note,
  };
}

function flow(side: "prod" | "cand", steps: StepCapture[]): FlowCapture {
  return {
    flow: "search",
    side,
    viewport: "mobile",
    pages: [],
    steps,
    totalDurationMs: 1000,
  };
}

describe("searchPresence", () => {
  it("skipa quando search flow não está no escopo", () => {
    const r = searchPresence(makeContext());
    expect(r.status).toBe("skipped");
  });

  it("passa quando ambos os lados têm search input", () => {
    const ok = [step("open-search", "ok", "prod")];
    const candOk = [step("open-search", "ok", "cand")];
    const r = searchPresence(
      makeContext({ prodFlows: [flow("prod", ok)], candFlows: [flow("cand", candOk)] }),
    );
    expect(r.status).toBe("pass");
  });

  it("critical quando cand não tem search input mas prod tem", () => {
    const r = searchPresence(
      makeContext({
        prodFlows: [flow("prod", [step("open-search", "ok", "prod")])],
        candFlows: [flow("cand", [step("open-search", "skipped", "cand", "input not detected")])],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("single-site: high quando search input não foi detectado", () => {
    const r = searchPresence(
      makeContext({
        candFlows: [flow("cand", [step("open-search", "skipped", "cand", "search input not detected")])],
      }),
    );
    expect(r.issues.some((i) => i.severity === "high")).toBe(true);
  });
});
