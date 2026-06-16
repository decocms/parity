/**
 * Per-phase timing instrumentation for `parity run`. Persists how long
 * each phase (launch, collect, vitals-pages, visual-diff, checks,
 * llm-aggregate, report) takes so the user can see where the wall-clock
 * went and optimize from data, not guesses.
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
 * Format a `RunTimings` snapshot for stdout. Uses simple ASCII bars so
 * it works in any terminal. Caller pipes to chalk if it wants color.
 */
export function formatTimingsSummary(timings: RunTimings): string {
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
    lines.push(`    ${p.phase.padEnd(maxLabel)}  ${formatMs(p.durationMs).padStart(7)}  ${bar} ${pctOfTotal}%`);
  }
  return lines.join("\n");
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec.toString().padStart(2, "0")}s`;
}
