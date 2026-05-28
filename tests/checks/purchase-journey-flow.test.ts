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

  it("#12: prod skipped (--accept-prod-quirks) + cand ok → não vira regressão", () => {
    // Cenário do issue: prod hit o quirk de cart vazio após page.goto e foi
    // demovido para "skipped" via --accept-prod-quirks. Cand exercitou o
    // step normalmente. O check não deve marcar como regressão — não há
    // sinal de problema em cand, e prod foi um quirk aceito.
    const prod = [
      step("add-to-cart", "ok"),
      step("open-minicart", "skipped", "cart-empty-prod-quirk: aceito via --accept-prod-quirks"),
      step("go-checkout", "skipped", "cart-empty-prod-quirk: skipped via --accept-prod-quirks"),
    ];
    const cand = [
      step("add-to-cart", "ok"),
      step("open-minicart", "ok"),
      step("go-checkout", "ok"),
    ];
    const r = purchaseJourneyFlow(ctx([flow("prod", prod)], [flow("cand", cand)]));
    expect(r.issues).toHaveLength(0);
    expect(r.status).toBe("pass");
  });

  it("aceita skip simétrico sem reportar", () => {
    const both = [step("shipping-calc-pdp", "skipped", "no CEP input on PDP")];
    const r = purchaseJourneyFlow(ctx([flow("prod", both)], [flow("cand", both)]));
    expect(r.issues).toHaveLength(0);
    expect(r.status).toBe("pass");
  });

  // ---------- Regressões anti silent-pass (issue: home quebrada com check pass) ----------

  it("skipa (não pass) quando purchase-journey nem foi requisitada no run", () => {
    // Nenhum dos lados produziu captura — o flow não estava no --flows
    const r = purchaseJourneyFlow(ctx([], []));
    expect(r.status).toBe("skipped");
    expect(r.issues).toHaveLength(0);
  });

  it("falha com critical quando cand não produziu captura mas prod sim", () => {
    // Home cand não hidratou, IntersectionObserver/Lazy/_serverFn quebrado,
    // selectors não acharam nada → cand não emite FlowCapture
    const prod = [step("visit-home", "ok"), step("add-to-cart", "ok")];
    const r = purchaseJourneyFlow(ctx([flow("prod", prod)], []));
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.severity === "critical" && /missing-cand/.test(i.id))).toBe(true);
  });

  it("alerta com high quando prod não produziu captura mas cand sim", () => {
    // Selectors quebrados contra prod (ex.: prod mudou markup) — não é crítico
    // pra cand mas é regressão do harness; high é o severity certo.
    const cand = [step("visit-home", "ok")];
    const r = purchaseJourneyFlow(ctx([], [flow("cand", cand)]));
    expect(r.status).toBe("warn");
    expect(r.issues.some((i) => /missing-prod/.test(i.id))).toBe(true);
  });

  it("falha com critical quando flow requisitada mas com 0 steps em ambos os lados", () => {
    // Capturas existem mas vazias — não há nada comparável, status não pode ser pass
    const r = purchaseJourneyFlow(ctx([flow("prod", [])], [flow("cand", [])]));
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.id === "pj:zero-steps-evaluated")).toBe(true);
  });
});
