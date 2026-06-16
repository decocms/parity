import { describe, expect, it } from "vitest";
import { cartRevealModeDivergence } from "../../src/checks/cart-reveal-mode.ts";
import type {
  FlowCapture,
  ParityIgnore,
  ParityRc,
  StepCapture,
  Viewport,
} from "../../src/types/schema.ts";
import type { CheckContext } from "../../src/checks/index.ts";

function step7(
  side: "prod" | "cand",
  viewport: Viewport,
  cartRevealMode: NonNullable<StepCapture["cartRevealMode"]>,
  status: StepCapture["status"] = "ok",
): StepCapture {
  return {
    step: 7,
    name: "open-minicart",
    side,
    viewport,
    status,
    durationMs: 100,
    screenshotPath: "",
    cartRevealMode,
  };
}

function flowWithStep7(
  side: "prod" | "cand",
  viewport: Viewport,
  mode: NonNullable<StepCapture["cartRevealMode"]>,
  status: StepCapture["status"] = "ok",
): FlowCapture {
  return {
    flow: "purchase-journey",
    side,
    viewport,
    pages: [],
    steps: [step7(side, viewport, mode, status)],
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

function ctx(
  prodFlows: FlowCapture[],
  candFlows: FlowCapture[],
  viewports: Viewport[] = ["mobile"],
): CheckContext {
  return {
    prodPages: [],
    candPages: [],
    prodFlows,
    candFlows,
    rc: RC,
    ignore: IGNORE,
    outDir: "/tmp",
    viewports,
  };
}

describe("cartRevealModeDivergence", () => {
  it("pass quando modos coincidem entre prod e cand", () => {
    const r = cartRevealModeDivergence(
      ctx([flowWithStep7("prod", "mobile", "hover-drawer")], [flowWithStep7("cand", "mobile", "hover-drawer")]),
    );
    expect(r.status).toBe("pass");
    expect(r.issues).toHaveLength(0);
  });

  it("CRITICAL quando prod=hover-drawer e cand=click-navigate-checkout (caso miess)", () => {
    const r = cartRevealModeDivergence(
      ctx(
        [flowWithStep7("prod", "mobile", "hover-drawer")],
        [flowWithStep7("cand", "mobile", "click-navigate-checkout")],
      ),
    );
    expect(r.status).toBe("fail");
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.severity).toBe("critical");
    expect(r.issues[0]!.summary).toMatch(/usuário em cand é levado direto/);
  });

  it("CRITICAL quando prod=inline-notification e cand=click-navigate-cart", () => {
    const r = cartRevealModeDivergence(
      ctx(
        [flowWithStep7("prod", "mobile", "inline-notification")],
        [flowWithStep7("cand", "mobile", "click-navigate-cart")],
      ),
    );
    expect(r.issues[0]!.severity).toBe("critical");
    expect(r.issues[0]!.summary).toMatch(/usuário em cand é levado direto/);
  });

  it("CRITICAL com nuance específica quando prod navega e cand abre drawer", () => {
    const r = cartRevealModeDivergence(
      ctx(
        [flowWithStep7("prod", "mobile", "click-navigate-checkout")],
        [flowWithStep7("cand", "mobile", "hover-drawer")],
      ),
    );
    expect(r.issues[0]!.severity).toBe("critical");
    expect(r.issues[0]!.summary).toMatch(/cand expõe um drawer/);
  });

  it("flagga divergência por viewport quando há múltiplos", () => {
    const r = cartRevealModeDivergence(
      ctx(
        [
          flowWithStep7("prod", "mobile", "hover-drawer"),
          flowWithStep7("prod", "desktop", "hover-drawer"),
        ],
        [
          flowWithStep7("cand", "mobile", "click-navigate-checkout"),
          flowWithStep7("cand", "desktop", "hover-drawer"),
        ],
        ["mobile", "desktop"],
      ),
    );
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.id).toBe("cart-reveal-mode:mobile:divergent");
    expect(r.issues[0]!.severity).toBe("critical");
  });

  it("não fire quando só um lado executou step 7 (purchase-journey-flow já cobre isso)", () => {
    const r = cartRevealModeDivergence(
      ctx([flowWithStep7("prod", "mobile", "hover-drawer")], []),
    );
    expect(r.issues).toHaveLength(0);
  });

  it("skipped quando nenhuma side rodou purchase-journey", () => {
    const r = cartRevealModeDivergence(ctx([], []));
    expect(r.status).toBe("skipped");
  });

  describe("issue #47: prod=unknown downgrades to medium + inconclusive", () => {
    it("emite MEDIUM + inconclusive quando prod=unknown e cand=inline-notification (caso miess)", () => {
      const r = cartRevealModeDivergence(
        ctx(
          [flowWithStep7("prod", "desktop", "unknown")],
          [flowWithStep7("cand", "desktop", "inline-notification")],
          ["desktop"],
        ),
      );
      expect(r.status).toBe("warn");
      expect(r.issues).toHaveLength(1);
      const issue = r.issues[0]!;
      expect(issue.severity).toBe("medium");
      expect(issue.inconclusive).toBe(true);
      expect(issue.id).toBe("cart-reveal-mode:desktop:inconclusive");
      expect(issue.summary).toMatch(/classificação cart reveal inconclusa/);
    });

    it("emite MEDIUM + inconclusive quando cand=unknown (heurística falhou na cand)", () => {
      const r = cartRevealModeDivergence(
        ctx(
          [flowWithStep7("prod", "mobile", "hover-drawer")],
          [flowWithStep7("cand", "mobile", "unknown")],
        ),
      );
      expect(r.issues[0]!.severity).toBe("medium");
      expect(r.issues[0]!.inconclusive).toBe(true);
    });

    it("ainda CRITICAL quando ambos foram classificados e divergem (não regrediu)", () => {
      const r = cartRevealModeDivergence(
        ctx(
          [flowWithStep7("prod", "mobile", "click-drawer")],
          [flowWithStep7("cand", "mobile", "click-navigate-cart")],
        ),
      );
      expect(r.issues[0]!.severity).toBe("critical");
      expect(r.issues[0]!.inconclusive).toBeUndefined();
    });

    it("PASS quando ambos são unknown (igual = igual, sem divergência)", () => {
      const r = cartRevealModeDivergence(
        ctx(
          [flowWithStep7("prod", "mobile", "unknown")],
          [flowWithStep7("cand", "mobile", "unknown")],
        ),
      );
      expect(r.status).toBe("pass");
      expect(r.issues).toHaveLength(0);
    });

    it("data.viewportsInconclusive conta inconclusivos separadamente de divergentes", () => {
      const r = cartRevealModeDivergence(
        ctx(
          [
            flowWithStep7("prod", "mobile", "unknown"),
            flowWithStep7("prod", "desktop", "hover-drawer"),
          ],
          [
            flowWithStep7("cand", "mobile", "click-drawer"),
            flowWithStep7("cand", "desktop", "click-navigate-cart"),
          ],
          ["mobile", "desktop"],
        ),
      );
      expect(r.data?.viewportsInconclusive).toBe(1);
      expect(r.data?.viewportsDivergent).toBe(1);
    });
  });

  it("ignora step 7 sem cartRevealMode (capturado em run antigo / sem detector)", () => {
    const oldFlow: FlowCapture = {
      flow: "purchase-journey",
      side: "prod",
      viewport: "mobile",
      pages: [],
      steps: [
        {
          step: 7,
          name: "open-minicart",
          side: "prod",
          viewport: "mobile",
          status: "ok",
          durationMs: 100,
          screenshotPath: "",
          // NO cartRevealMode (legacy run)
        },
      ],
      totalDurationMs: 1000,
    };
    const r = cartRevealModeDivergence(
      ctx([oldFlow], [flowWithStep7("cand", "mobile", "click-navigate-checkout")]),
    );
    // prod side = null → não comparável → no issue emitted
    expect(r.issues).toHaveLength(0);
  });
});
