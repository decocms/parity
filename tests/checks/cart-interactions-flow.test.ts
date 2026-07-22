import { describe, expect, it } from "vitest";
import { cartInteractionsFlow } from "../../src/checks/cart-interactions-flow.ts";
import type { FlowCapture, StepCapture } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";

function step(
  name: string,
  status: StepCapture["status"],
  side: "prod" | "cand",
  note?: string,
): StepCapture {
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
    const prod = [step("seed-cart", "ok", "prod"), step("increment-qty", "ok", "prod")];
    const cand = [step("seed-cart", "ok", "cand"), step("increment-qty", "failed", "cand")];
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

  it("passa quando validate-multi-item ok em ambos os lados", () => {
    const prod = [
      step("seed-cart", "ok", "prod"),
      step("add-second-item", "ok", "prod"),
      step("validate-multi-item", "ok", "prod"),
    ];
    const cand = prod.map((s) => ({ ...s, side: "cand" as const }));
    const r = cartInteractionsFlow(
      makeContext({ prodFlows: [flow("prod", prod)], candFlows: [flow("cand", cand)] }),
    );
    expect(r.status).toBe("pass");
  });

  it("critical quando validate-multi-item ok em prod mas failed em cand (comparativo)", () => {
    const prod = [
      step("seed-cart", "ok", "prod"),
      step("add-second-item", "ok", "prod"),
      step("validate-multi-item", "ok", "prod"),
    ];
    const cand = [
      step("seed-cart", "ok", "cand"),
      step("add-second-item", "ok", "cand"),
      step("validate-multi-item", "failed", "cand", "carrinho só aceitou 1 item"),
    ];
    const r = cartInteractionsFlow(
      makeContext({ prodFlows: [flow("prod", prod)], candFlows: [flow("cand", cand)] }),
    );
    const issue = r.issues.find((i) => i.id.includes("validate-multi-item"));
    expect(issue?.severity).toBe("critical");
    expect(r.status).toBe("fail");
  });

  it("single-site: skipped quando add-second-item não achou 2º produto (não falha o flow)", () => {
    const r = cartInteractionsFlow(
      makeContext({
        candFlows: [
          flow("cand", [
            step("seed-cart", "ok", "cand"),
            step("add-second-item", "skipped", "cand", "PLP só tem um produto"),
            step("validate-multi-item", "skipped", "cand", "add-second-item não completou"),
          ]),
        ],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues.length).toBe(0);
  });
});

describe("apply-valid-coupon", () => {
  it("high (não critical) quando ok em prod mas failed em cand — não é CRITICAL_STEPS", () => {
    const r = cartInteractionsFlow(
      makeContext({
        prodFlows: [flow("prod", [step("apply-valid-coupon", "ok", "prod")])],
        candFlows: [
          flow("cand", [step("apply-valid-coupon", "failed", "cand", "desconto não aplicado")]),
        ],
      }),
    );
    const issue = r.issues.find((i) => i.id.includes("apply-valid-coupon"));
    expect(issue?.severity).toBe("high");
    expect(r.status).toBe("warn");
  });

  it("single-site: skipped não gera issue (sem validCode configurado)", () => {
    const r = cartInteractionsFlow(
      makeContext({
        candFlows: [
          flow("cand", [
            step("apply-valid-coupon", "skipped", "cand", "rc.coupon.validCode não configurado"),
          ]),
        ],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues.length).toBe(0);
  });
});
