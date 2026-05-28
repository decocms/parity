import { describe, expect, it } from "vitest";
import { auditVitals } from "../../src/audit/vitals.ts";
import { classifyVital } from "../../src/audit/thresholds.ts";

describe("classifyVital — Core Web Vitals thresholds", () => {
  it("LCP good (≤ 2500ms) não vira issue", () => {
    expect(classifyVital("lcp", 2500).severity).toBe("ok");
    expect(classifyVital("lcp", 1200).severity).toBe("ok");
  });

  it("LCP needs-improvement (2500-4000ms) → medium", () => {
    expect(classifyVital("lcp", 3500).severity).toBe("medium");
  });

  it("LCP poor (>4000ms) → high", () => {
    expect(classifyVital("lcp", 5000).severity).toBe("high");
  });

  it("LCP crítico (>2× poor) → critical", () => {
    expect(classifyVital("lcp", 9000).severity).toBe("critical");
  });

  it("CLS good (≤ 0.10) → ok", () => {
    expect(classifyVital("cls", 0.05).severity).toBe("ok");
    expect(classifyVital("cls", 0.10).severity).toBe("ok");
  });

  it("CLS 0.30 (poor) → high", () => {
    expect(classifyVital("cls", 0.30).severity).toBe("high");
  });

  it("CLS catastrófico (>2× poor=0.5) → critical", () => {
    expect(classifyVital("cls", 0.8).severity).toBe("critical");
  });

  it("TTFB sem critical multiplier — só vai até high mesmo se 10s", () => {
    expect(classifyVital("ttfb", 10_000).severity).toBe("high");
  });
});

describe("auditVitals", () => {
  it("retorna lista vazia quando vitals está em 'good'", () => {
    const r = auditVitals("/::mobile", {
      lcp: 1500,
      cls: 0.05,
      fcp: 1000,
      inp: 100,
      ttfb: 400,
    });
    expect(r).toHaveLength(0);
  });

  it("emite 1 issue por métrica fora de good", () => {
    const r = auditVitals("/::mobile", {
      lcp: 5000, // poor → high
      cls: 0.3, // poor → high
      fcp: null, // skip
      inp: 250, // ni → medium
      ttfb: 400, // good → no issue
    });
    expect(r).toHaveLength(3);
    expect(r.map((i) => i.severity).sort()).toEqual(["high", "high", "medium"]);
  });

  it("pula métricas null (não medidas)", () => {
    const r = auditVitals("/::mobile", {
      lcp: null,
      cls: null,
      fcp: null,
      inp: null,
      ttfb: null,
    });
    expect(r).toHaveLength(0);
  });

  it("inclui hint detalhado pra cada métrica", () => {
    const r = auditVitals("/::mobile", {
      lcp: 5000,
      cls: null,
      fcp: null,
      inp: null,
      ttfb: null,
    });
    expect(r[0]?.details).toMatch(/priority\+preload|hero image/i);
  });
});
