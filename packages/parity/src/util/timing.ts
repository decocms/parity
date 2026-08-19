/**
 * Per-phase timing instrumentation for `parity run`. Persists how long
 * each phase takes so the user can see where the wall-clock went and
 * optimize from data, not guesses.
 *
 * Phases currently stamped by `runCommand`:
 *   - `collect`        — browser launch + warmup + all flow captures
 *   - `vitals-pages`   — extra sitemap-discovered page captures
 *   - `visual-diff`    — visual-diff page captures
 *   - `checks`         — sequential check pipeline
 *   - `llm-aggregate`  — LLM issue aggregation (or offline fallback)
 *   - `report`         — JSON + HTML report writes (patched into the
 *                         JSON post-render; the HTML bar excludes it)
 *
 * NOTE: there's no separate `launch` phase — `collect` includes browser
 * launch, warmup, and the flow loop. Separating them was deemed not
 * worth the cross-cutting churn for what's typically <2s overhead.
 *
 * Builds on PR-3 (issue #56): `currentPhase` already labels phases for
 * the shutdown banner; this PR records their durations.
 */

export interface PhaseTiming {
  /** Phase label, e.g. "vitals-pages". */
  phase: string;
  /** Milliseconds elapsed end-to-end for this phase. */
  durationMs: number;
}

export interface RunTimings {
  /** Total wall-clock from runCommand entry to report write. */
  totalMs: number;
  /** Ordered list of phases in execution order. */
  phases: PhaseTiming[];
}

/**
 * Run an async function and return both its result and how long it took.
 * Always pairs `start`/`end` in the same expression so callers can't
 * accidentally forget the `end()` call.
 */
export async function withTiming<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

/**
 * Simple ordered accumulator. Designed for runCommand's linear phase
 * sequence — we don't need nested timings or parallel phase tracking
 * (each is gated by `await` already).
 */
export class TimingRegistry {
  private readonly start: number;
  private readonly phases: PhaseTiming[] = [];

  constructor() {
    this.start = performance.now();
  }

  /** Run `fn` and record `phase` + its duration. Returns the fn result. */
  async record<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    const { result, durationMs } = await withTiming(fn);
    this.phases.push({ phase, durationMs });
    return result;
  }

  /** Append a phase that was timed externally (e.g. nested inside a try). */
  push(phase: string, durationMs: number): void {
    this.phases.push({ phase, durationMs });
  }

  /** Finalize and return a snapshot of all timings. */
  finalize(): RunTimings {
    return {
      totalMs: performance.now() - this.start,
      phases: [...this.phases],
    };
  }
}

/**
 * Per-flow timing surfaced to the bottom-of-run summary. Sides ran in
 * parallel within a viewport, so `maxMs` (longest side's duration) is
 * the real wall-clock contribution that flow added to the run. The
 * sides list is for transparency.
 */
export interface FlowTimingBreakdown {
  /** Flow name, e.g. "purchase-journey". */
  flow: string;
  /** Wall-clock = longest of `sides`. */
  maxMs: number;
  /** Per-(viewport,side) durations, in completion order. */
  sides: Array<{ viewport: string; side: string; durationMs: number }>;
}

/**
 * Format a `RunTimings` snapshot for stdout. Uses simple ASCII bars so
 * it works in any terminal. Caller pipes to chalk if it wants color.
 * When `flowBreakdown` is provided, an extra block lists each flow's
 * `max` time (the parallel-wall-clock contribution) plus the per-side
 * detail so the user can see where prod or cand was the long pole.
 */
export function formatTimingsSummary(
  timings: RunTimings,
  flowBreakdown?: FlowTimingBreakdown[],
): string {
  if (timings.phases.length === 0) {
    return `⏱  Run completed in ${formatMs(timings.totalMs)}`;
  }
  const max = Math.max(...timings.phases.map((p) => p.durationMs));
  const maxLabel = Math.max(...timings.phases.map((p) => p.phase.length));
  const lines: string[] = [`⏱  Run completed in ${formatMs(timings.totalMs)}`];
  for (const p of timings.phases) {
    const pct = max > 0 ? Math.round((p.durationMs / max) * 16) : 0;
    const bar = "█".repeat(pct) + "░".repeat(16 - pct);
    const pctOfTotal = timings.totalMs > 0 ? Math.round((p.durationMs / timings.totalMs) * 100) : 0;
    lines.push(
      `    ${p.phase.padEnd(maxLabel)}  ${formatMs(p.durationMs).padStart(7)}  ${bar} ${pctOfTotal}%`,
    );
  }
  if (flowBreakdown && flowBreakdown.length > 0) {
    const maxFlowLabel = Math.max(...flowBreakdown.map((f) => f.flow.length));
    lines.push("");
    lines.push("    flows breakdown (sides run in parallel within viewport)");
    for (const f of flowBreakdown) {
      const sideDetail = f.sides
        .map((s) => `${s.viewport}/${s.side} ${formatMs(s.durationMs)}`)
        .join(" · ");
      lines.push(
        `    ${f.flow.padEnd(maxFlowLabel)}  max ${formatMs(f.maxMs).padStart(6)} · ${sideDetail}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Build a per-flow breakdown from raw `FlowCapture`-shaped entries.
 * Groups by flow name and reports max + the underlying sides.
 */
export function buildFlowBreakdown(
  captures: Array<{ flow: string; viewport: string; side: string; totalDurationMs: number }>,
): FlowTimingBreakdown[] {
  const byFlow = new Map<string, FlowTimingBreakdown>();
  for (const c of captures) {
    const existing = byFlow.get(c.flow);
    const entry = {
      viewport: c.viewport,
      side: c.side,
      durationMs: c.totalDurationMs,
    };
    if (!existing) {
      byFlow.set(c.flow, {
        flow: c.flow,
        maxMs: c.totalDurationMs,
        sides: [entry],
      });
    } else {
      existing.sides.push(entry);
      if (c.totalDurationMs > existing.maxMs) existing.maxMs = c.totalDurationMs;
    }
  }
  // Preserve declaration order from input.
  return Array.from(byFlow.values());
}

export function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec.toString().padStart(2, "0")}s`;
}
