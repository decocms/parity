import { describe, expect, it } from "vitest";
import { loginFlow } from "../../src/checks/login-flow.ts";
import type { FlowCapture, StepCapture } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";

function step(name: string, status: StepCapture["status"], side: "prod" | "cand", note?: string): StepCapture {
  return {
    step: 1,
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
  return { flow: "login", side, viewport: "mobile", pages: [], steps, totalDurationMs: 1000 };
}

describe("loginFlow", () => {
  it("skipa quando flow não rodou", () => {
    const r = loginFlow(makeContext());
    expect(r.status).toBe("skipped");
  });

  it("passa quando login funciona em ambos", () => {
    const steps = [
      step("visit-home", "ok", "prod"),
      step("open-login", "ok", "prod"),
      step("submit-invalid", "ok", "prod"),
      step("submit-valid", "ok", "prod"),
      step("verify-account-area", "ok", "prod"),
    ];
    const cands = steps.map((s) => ({ ...s, side: "cand" as const }));
    const r = loginFlow(makeContext({ prodFlows: [flow("prod", steps)], candFlows: [flow("cand", cands)] }));
    expect(r.status).toBe("pass");
  });

  it("critical quando submit-valid falha em cand", () => {
    const prod = [step("submit-valid", "ok", "prod")];
    const cand = [step("submit-valid", "failed", "cand", "accountMenu não detectado")];
    const r = loginFlow(makeContext({ prodFlows: [flow("prod", prod)], candFlows: [flow("cand", cand)] }));
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("single-site: critical quando submit-valid falha", () => {
    const r = loginFlow(
      makeContext({
        candFlows: [
          flow("cand", [step("submit-valid", "failed", "cand", "credenciais não funcionaram")]),
        ],
      }),
    );
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });
});
