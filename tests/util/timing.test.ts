import { describe, expect, it } from "vitest";
import {
  type RunTimings,
  TimingRegistry,
  formatTimingsSummary,
  withTiming,
} from "../../src/util/timing.ts";

describe("withTiming", () => {
  it("retorna resultado + durationMs", async () => {
    const { result, durationMs } = await withTiming(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return 42;
    });
    expect(result).toBe(42);
    expect(durationMs).toBeGreaterThanOrEqual(25);
    expect(durationMs).toBeLessThan(200);
  });

  it("propaga exceções da fn", async () => {
    await expect(
      withTiming(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("TimingRegistry", () => {
  it("record acumula fases na ordem de chamada", async () => {
    const reg = new TimingRegistry();
    await reg.record("a", async () => {});
    await reg.record("b", async () => {});
    await reg.record("c", async () => {});
    const t = reg.finalize();
    expect(t.phases.map((p) => p.phase)).toEqual(["a", "b", "c"]);
  });

  it("record retorna o resultado da fn", async () => {
    const reg = new TimingRegistry();
    const out = await reg.record("phase", async () => "hello");
    expect(out).toBe("hello");
  });

  it("push adiciona fase externamente cronometrada", () => {
    const reg = new TimingRegistry();
    reg.push("manual", 1234);
    const t = reg.finalize();
    expect(t.phases).toEqual([{ phase: "manual", durationMs: 1234 }]);
  });

  it("totalMs cobre todas as fases acumuladas", async () => {
    const reg = new TimingRegistry();
    await reg.record("x", async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const t = reg.finalize();
    expect(t.totalMs).toBeGreaterThanOrEqual(20);
  });

  it("phases é uma cópia (não vaza estado interno)", async () => {
    const reg = new TimingRegistry();
    await reg.record("a", async () => {});
    const snapshot1 = reg.finalize();
    await reg.record("b", async () => {});
    expect(snapshot1.phases.length).toBe(1);
  });
});

describe("formatTimingsSummary (issue: observability of phase costs)", () => {
  it("imprime totalMs e cada fase com bar chart", () => {
    const t: RunTimings = {
      totalMs: 60_000,
      phases: [
        { phase: "launch", durationMs: 5_000 },
        { phase: "checks", durationMs: 30_000 },
        { phase: "llm", durationMs: 25_000 },
      ],
    };
    const out = formatTimingsSummary(t);
    expect(out).toContain("Run completed in 1m00s");
    expect(out).toContain("launch");
    expect(out).toContain("checks");
    expect(out).toContain("llm");
    expect(out).toContain("█");
    expect(out).toMatch(/\d+%/);
  });

  it("fallback minimal quando phases está vazio", () => {
    const out = formatTimingsSummary({ totalMs: 1500, phases: [] });
    expect(out).toBe("⏱  Run completed in 1s");
  });

  it("formato MmSSs pra durações longas", () => {
    const out = formatTimingsSummary({
      totalMs: 125_000,
      phases: [{ phase: "x", durationMs: 125_000 }],
    });
    expect(out).toContain("2m05s");
  });
});
