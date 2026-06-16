/**
 * Per-phase heartbeat: keeps the spinner text alive so the user knows the
 * run is still working even when an inner task (browser launch, page
 * capture, LLM call) hasn't completed yet. Issue #56.
 *
 * Without this, parity's spinner stays mute for minutes at a time during
 * "Coletando vitals em páginas extras…", "Rodando checks…", or
 * "Agregando issues via LLM…". The user has no way to tell if the
 * candidate hung, the browser crashed, or things are just slow.
 */

export interface HeartbeatHandle {
  /** Stop the heartbeat. Safe to call multiple times. */
  stop: () => void;
  /**
   * Reset the "since last progress" timer. Call when a sub-task completes
   * so the heartbeat reflects fresh activity instead of cumulative wait.
   */
  bump: () => void;
}

export interface HeartbeatOptions {
  /** Tick interval. Default: 30s. */
  intervalMs?: number;
  /** Called on each tick with elapsed + since-last-bump deltas. */
  onTick: (info: { elapsedMs: number; sinceLastBumpMs: number }) => void;
}

export function startHeartbeat(opts: HeartbeatOptions): HeartbeatHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const start = Date.now();
  let lastBump = start;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    opts.onTick({
      elapsedMs: Date.now() - start,
      sinceLastBumpMs: Date.now() - lastBump,
    });
  }, intervalMs);
  // setInterval's handle keeps Node alive; allow process exit during heartbeats.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    bump: () => {
      lastBump = Date.now();
    },
  };
}

/** Minimal subset of `ora.Ora` we need — keeps tests free of ora dep. */
export interface SpinnerLike {
  text: string;
}

/**
 * Attach a heartbeat to a spinner. Updates `spinner.text` every tick with
 * `${baseText} (Ys elapsed, Xs since last progress)` so a phase that hangs
 * for 5min still surfaces a visible "Xs" counter.
 *
 * Returns the same handle as `startHeartbeat`; the caller MUST `stop()`
 * before calling `spinner.succeed()` so the heartbeat doesn't overwrite
 * the success text.
 */
export function attachSpinnerHeartbeat(
  spinner: SpinnerLike,
  opts: { baseText: string; intervalMs?: number },
): HeartbeatHandle {
  spinner.text = opts.baseText;
  return startHeartbeat({
    intervalMs: opts.intervalMs,
    onTick: ({ elapsedMs, sinceLastBumpMs }) => {
      const elapsed = formatSecs(elapsedMs);
      const sinceBump = formatSecs(sinceLastBumpMs);
      spinner.text = `${opts.baseText} (${elapsed} elapsed, ${sinceBump} since last progress)`;
    },
  });
}

function formatSecs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${sec.toString().padStart(2, "0")}s`;
}
