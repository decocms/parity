import { describe, expect, it } from "vitest";
import type { CheckContext } from "../../src/checks/index.ts";
import { purchaseJourneyFlow } from "../../src/checks/purchase-journey-flow.ts";
import type { FlowCapture, ParityIgnore, ParityRc, StepCapture } from "../../src/types/schema.ts";

function step(name: string, status: StepCapture["status"], note?: string): StepCapture {
  return {
    step: 1,
    name,
    side: "prod",
    viewport: "mobile",
    status,
    durationMs: 100,
    screenshotPath: "",
    note,
  };
}

function flow(side: "prod" | "cand", steps: StepCapture[]): FlowCapture {
  return {
    flow: "purchase-journey",
    side,
    viewport: "mobile",
    pages: [],
    steps: steps.map((s) => ({ ...s, side })),
    totalDurationMs: 1000,
  };
}

const RC: ParityRc = { cep: "01310-100", selectors: {}, skipSteps: [] };
const IGNORE: ParityIgnore = {
  ignoreSelectorsVisual: [],
  ignoreRequestPatterns: [],
  ignoreConsolePatterns: [],
  ignoreMetaKeys: [],
  toleratedDomDrift: {},
};

function ctx(prod: FlowCapture[], cand: FlowCapture[]): CheckContext {
  return {
    prodPages: [],
    candPages: [],
    prodFlows: prod,
    candFlows: cand,
    rc: RC,
    ignore: IGNORE,
    outDir: "/tmp",
    viewports: ["mobile"],
  };
}

describe("purchaseJourneyFlow check", () => {
  it("passa quando todos os steps casam", () => {
    const steps = [step("visit-home", "ok"), step("navigate-plp", "ok"), step("add-to-cart", "ok")];
    const r = purchaseJourneyFlow(ctx([flow("prod", steps)], [flow("cand", steps)]));
    expect(r.status).toBe("pass");
    expect(r.issues).toHaveLength(0);
  });

  it("vira critical quando step crítico falha em cand mas passa em prod", () => {
    const prod = [step("visit-home", "ok"), step("add-to-cart", "ok")];
    const cand = [step("visit-home", "ok"), step("add-to-cart", "failed")];
    const r = purchaseJourneyFlow(ctx([flow("prod", prod)], [flow("cand", cand)]));
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("aponta skipped assimétrico como regressão", () => {
    const prod = [step("shipping-calc-pdp", "ok")];
    const cand = [step("shipping-calc-pdp", "skipped", "no CEP input on PDP")];
    const r = purchaseJourneyFlow(ctx([flow("prod", prod)], [flow("cand", cand)]));
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.summary).toMatch(/pulou em cand/);
  });

  it("aceita skip simétrico sem reportar", () => {
    const both = [step("shipping-calc-pdp", "skipped", "no CEP input on PDP")];
    const r = purchaseJourneyFlow(ctx([flow("prod", both)], [flow("cand", both)]));
    expect(r.issues).toHaveLength(0);
    expect(r.status).toBe("pass");
  });
});
