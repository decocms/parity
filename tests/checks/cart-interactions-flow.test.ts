import { describe, expect, it } from "vitest";
import { cartInteractionsFlow } from "../../src/checks/cart-interactions-flow.ts";
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
  return {
    flow: "cart-interactions",
    side,
    viewport: "mobile",
    pages: [],
    steps,
    totalDurationMs: 1000,
  };
}

describe("cartInteractionsFlow", () => {
  it("skipa quando flow não rodou", () => {
    const r = cartInteractionsFlow(makeContext());
    expect(r.status).toBe("skipped");
  });

  it("passa quando todos steps casam", () => {
    const steps = [
      step("seed-cart", "ok", "prod"),
      step("increment-qty", "ok", "prod"),
      step("remove-item", "ok", "prod"),
    ];
    const cands = steps.map((s) => ({ ...s, side: "cand" as const }));
    const r = cartInteractionsFlow(
      makeContext({ prodFlows: [flow("prod", steps)], candFlows: [flow("cand", cands)] }),
    );
    expect(r.status).toBe("pass");
  });

  it("critical quando seed-cart falha em cand", () => {
    const prod = [step("seed-cart", "ok", "prod")];
    const cand = [step("seed-cart", "failed", "cand", "no buy button")];
    const r = cartInteractionsFlow(
      makeContext({ prodFlows: [flow("prod", prod)], candFlows: [flow("cand", cand)] }),
    );
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("high quando increment falhou em cand", () => {
    const prod = [
      step("seed-cart", "ok", "prod"),
      step("increment-qty", "ok", "prod"),
    ];
    const cand = [
      step("seed-cart", "ok", "cand"),
      step("increment-qty", "failed", "cand"),
    ];
    const r = cartInteractionsFlow(
      makeContext({ prodFlows: [flow("prod", prod)], candFlows: [flow("cand", cand)] }),
    );
    expect(r.issues.some((i) => i.severity === "high")).toBe(true);
  });

  it("single-site: critical quando seed-cart falhou", () => {
    const r = cartInteractionsFlow(
      makeContext({
        candFlows: [flow("cand", [step("seed-cart", "failed", "cand", "no PDP found")])],
      }),
    );
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });
});
