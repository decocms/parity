import { describe, expect, it } from "vitest";
import { spaNavigationFlow } from "../../src/checks/spa-navigation-flow.ts";
import type { FlowCapture, StepCapture } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";

function step(
  name: string,
  status: StepCapture["status"],
  side: "prod" | "cand",
  over: Partial<StepCapture> = {},
): StepCapture {
  return {
    step: 1,
    name,
    side,
    viewport: "mobile",
    status,
    durationMs: 100,
    screenshotPath: "",
    ...over,
  };
}

function flow(side: "prod" | "cand", steps: StepCapture[]): FlowCapture {
  return {
    flow: "spa-navigation",
    side,
    viewport: "mobile",
    pages: [],
    steps,
    totalDurationMs: 1000,
  };
}

describe("spaNavigationFlow", () => {
  it("skips when the flow didn't run", () => {
    const r = spaNavigationFlow(makeContext());
    expect(r.status).toBe("skipped");
  });

  it("passes when both sides keep section parity and no hydration errors", () => {
    const steps = [
      step("load-via-f5", "ok", "prod"),
      step("navigate-via-spa", "ok", "prod", { detail: { hydrationErrorCount: 0 } }),
      step("verify-section-parity", "ok", "prod"),
    ];
    const cand = steps.map((s) => ({ ...s, side: "cand" as const }));
    const r = spaNavigationFlow(
      makeContext({ prodFlows: [flow("prod", steps)], candFlows: [flow("cand", cand)] }),
    );
    expect(r.status).toBe("pass");
  });

  it("critical: verify-section-parity fails in cand but not prod (comparative)", () => {
    const prod = [step("verify-section-parity", "ok", "prod")];
    const cand = [
      step("verify-section-parity", "failed", "cand", {
        note: "SPA-nav render mostrou menos sections",
      }),
    ];
    const r = spaNavigationFlow(
      makeContext({ prodFlows: [flow("prod", prod)], candFlows: [flow("cand", cand)] }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("single-site: critical when verify-section-parity fails alone", () => {
    const r = spaNavigationFlow(
      makeContext({
        candFlows: [flow("cand", [step("verify-section-parity", "failed", "cand")])],
      }),
    );
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("high: hydration errors during navigate-via-spa in cand only (comparative)", () => {
    const prod = [step("navigate-via-spa", "ok", "prod", { detail: { hydrationErrorCount: 0 } })];
    const cand = [
      step("navigate-via-spa", "ok", "cand", {
        detail: { hydrationErrorCount: 2, hydrationSamples: ["Minified React error #418"] },
      }),
    ];
    const r = spaNavigationFlow(
      makeContext({ prodFlows: [flow("prod", prod)], candFlows: [flow("cand", cand)] }),
    );
    const issue = r.issues.find((i) => i.id.includes("hydration"));
    expect(issue?.severity).toBe("high");
  });

  it("single-site: high when hydration errors appear during navigate-via-spa", () => {
    const r = spaNavigationFlow(
      makeContext({
        candFlows: [
          flow("cand", [
            step("navigate-via-spa", "ok", "cand", { detail: { hydrationErrorCount: 3 } }),
          ]),
        ],
      }),
    );
    const issue = r.issues.find((i) => i.id.includes("hydration"));
    expect(issue?.severity).toBe("high");
  });

  it("no issue when navigate-via-spa was skipped (no SPA behavior detected)", () => {
    const r = spaNavigationFlow(
      makeContext({
        candFlows: [
          flow("cand", [
            step("navigate-via-spa", "skipped", "cand", {
              note: "click não navegou",
            }),
            step("verify-section-parity", "skipped", "cand", {
              note: "sem destino para verificar",
            }),
          ]),
        ],
      }),
    );
    expect(r.issues.length).toBe(0);
    expect(r.status).toBe("pass");
  });
});
