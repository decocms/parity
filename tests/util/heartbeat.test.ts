import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SpinnerLike,
  attachSpinnerHeartbeat,
  startHeartbeat,
} from "../../src/util/heartbeat.ts";

describe("startHeartbeat (issue #56: per-phase progress beacons)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("chama onTick a cada intervalMs (default 30s)", () => {
    const ticks: number[] = [];
    const h = startHeartbeat({
      intervalMs: 1_000,
      onTick: ({ elapsedMs }) => ticks.push(elapsedMs),
    });
    vi.advanceTimersByTime(3_500);
    h.stop();
    expect(ticks.length).toBe(3); // ~1s, ~2s, ~3s
    expect(ticks[0]).toBeGreaterThanOrEqual(1_000);
  });

  it("bump() reseta a contagem 'sinceLastBumpMs' sem tocar 'elapsedMs'", () => {
    const ticks: { elapsedMs: number; sinceLastBumpMs: number }[] = [];
    const h = startHeartbeat({
      intervalMs: 1_000,
      onTick: (info) => ticks.push(info),
    });
    vi.advanceTimersByTime(2_500); // 2 ticks
    h.bump();
    vi.advanceTimersByTime(1_500); // 1 more tick após o bump
    h.stop();
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    const last = ticks[ticks.length - 1]!;
    // sinceLastBumpMs deve ser <= 1500 (último tick foi ~1s após bump,
    // mas fake-timers rodam o tick exatamente quando completam o intervalo)
    expect(last.sinceLastBumpMs).toBeLessThanOrEqual(1_500);
    // elapsedMs continua subindo (não reseta)
    expect(last.elapsedMs).toBeGreaterThanOrEqual(3_500);
  });

  it("stop() é idempotente — chamar 2× não estoura", () => {
    const h = startHeartbeat({ intervalMs: 1_000, onTick: () => {} });
    expect(() => {
      h.stop();
      h.stop();
    }).not.toThrow();
  });

  it("não chama onTick após stop()", () => {
    const onTick = vi.fn();
    const h = startHeartbeat({ intervalMs: 100, onTick });
    vi.advanceTimersByTime(250); // 2 ticks
    const callsBefore = onTick.mock.calls.length;
    h.stop();
    vi.advanceTimersByTime(1_000);
    expect(onTick.mock.calls.length).toBe(callsBefore);
  });
});

describe("attachSpinnerHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("atualiza spinner.text com 'elapsed' + 'since last progress' a cada tick", () => {
    const spinner: SpinnerLike = { text: "" };
    const h = attachSpinnerHeartbeat(spinner, {
      baseText: "Coletando vitals…",
      intervalMs: 1_000,
    });
    expect(spinner.text).toBe("Coletando vitals…"); // base aplicado imediatamente
    vi.advanceTimersByTime(2_500);
    h.stop();
    expect(spinner.text).toMatch(/Coletando vitals…/);
    expect(spinner.text).toMatch(/elapsed/);
    expect(spinner.text).toMatch(/since last progress/);
  });

  it("formata segundos curtos como 'Xs' e longos como 'YmZZs'", () => {
    const spinner: SpinnerLike = { text: "" };
    const h = attachSpinnerHeartbeat(spinner, {
      baseText: "x",
      intervalMs: 1_000,
    });
    vi.advanceTimersByTime(75_000); // 1m15s
    h.stop();
    expect(spinner.text).toMatch(/1m15s elapsed/);
  });

  it("preserva o baseText após múltiplos ticks (não acumula)", () => {
    const spinner: SpinnerLike = { text: "ORIGINAL" };
    const h = attachSpinnerHeartbeat(spinner, {
      baseText: "Rodando checks…",
      intervalMs: 1_000,
    });
    vi.advanceTimersByTime(5_500);
    h.stop();
    // Não deve haver concatenação de "Rodando checks… Rodando checks… …"
    const matches = spinner.text.match(/Rodando checks…/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
