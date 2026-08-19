// Reusable Lighthouse runner — a fresh `npx lighthouse` process per page with
// real (not simulated) mobile throttling (Slow 4G + 4x CPU) via
// `--throttling-method=devtools`. Extracted from
// `scripts/farmrio-vitals-check.ts` so both that spike and the `parity
// benchmark` command share one hardened implementation.
//
// The hardening here is load-bearing and was earned against real failures:
//   - NO_FCP on heavy/uncached pages under 4x CPU throttling (~1/3 of runs on
//     the heaviest pages) — retried by the caller instead of dropped.
//   - Windows MAX_PATH blowouts from long product-slug output paths — short
//     ids, not slugs, in the output filename.
//   - chrome-launcher EPERM/ENOENT under a contended system Temp dir — each
//     run gets its own writable TEMP.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LhSample {
  lcp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
  tbt: number | null;
}

export type LhResult = LhSample | { error: string };

export interface LighthouseOptions {
  /** Directory for the raw report JSON + per-run temp dirs. Created if missing. */
  outDir: string;
  /** Stable short id for the output filename (NOT a URL slug — MAX_PATH). */
  id: string;
  formFactor?: "mobile" | "desktop";
  /** Max NO_FCP-style retries before giving up. Default 3. */
  maxAttempts?: number;
}

/**
 * Measure one URL, retrying transient NO_FCP failures. Returns an `LhSample`
 * on success or `{ error }` after exhausting attempts.
 */
export async function measureLighthouse(url: string, opts: LighthouseOptions): Promise<LhResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let last: LhResult = { error: "never attempted" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await measureLighthouseOnce(url, opts, attempt);
    if (!("error" in last)) return last;
  }
  return last;
}

async function measureLighthouseOnce(
  url: string,
  opts: LighthouseOptions,
  attempt: number,
): Promise<LhResult> {
  const formFactor = opts.formFactor ?? "mobile";
  mkdirSync(opts.outDir, { recursive: true });
  const outPath = join(opts.outDir, `${opts.id}-a${attempt}.json`);
  // chrome-launcher's default user-data-dir lands under the shared system Temp
  // dir and can hit EPERM there (Windows AV/ACL flakiness) — give this run its
  // own writable TEMP so chrome-launcher's tmp dir creation lands somewhere
  // uncontended instead of fighting --chrome-flags quoting.
  const runTemp = join(opts.outDir, `.tmp-${opts.id}-a${attempt}`);
  mkdirSync(runTemp, { recursive: true });
  const args = [
    "--yes",
    "lighthouse",
    url,
    "--output=json",
    `--output-path=${outPath}`,
    "--only-categories=performance",
    `--form-factor=${formFactor}`,
    // Desktop form-factor requires matching screen emulation — Lighthouse
    // defaults screenEmulation to mobile and errors ("mobile setting (true)
    // does not match formFactor (desktop)") unless we flip it here.
    ...(formFactor === "desktop"
      ? [
          "--screenEmulation.mobile=false",
          "--screenEmulation.width=1350",
          "--screenEmulation.height=940",
          "--screenEmulation.deviceScaleFactor=1",
        ]
      : []),
    "--throttling-method=devtools",
    "--chrome-flags=--headless=new",
    "--quiet",
    "--max-wait-for-load=90000",
  ];
  const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
    const proc = spawn("npx", args, {
      shell: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, TEMP: runTemp, TMP: runTemp },
    });
    let stderrBuf = "";
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });
    proc.on("close", (exitCode) => resolve({ code: exitCode ?? 1, stderr: stderrBuf }));
    proc.on("error", (err) => resolve({ code: 1, stderr: err.message }));
  });
  let report: {
    audits: Record<string, { numericValue?: number }>;
    runtimeError?: { code: string; message: string };
  };
  try {
    report = JSON.parse(readFileSync(outPath, "utf-8"));
  } catch (err) {
    // chrome-launcher often fails its own post-run tmp-dir cleanup and exits 1
    // even though the report was already written fine — that case parses OK
    // and never reaches here. This catch is for a genuinely missing/corrupt file.
    return {
      error:
        code !== 0
          ? `lighthouse exit ${code}: ${stderr.slice(0, 200)}`
          : `parse failed: ${(err as Error).message}`,
    };
  }
  if (report.runtimeError) {
    return { error: `${report.runtimeError.code}: ${report.runtimeError.message.slice(0, 150)}` };
  }
  const audits = report.audits;
  const lcp = audits["largest-contentful-paint"]?.numericValue ?? null;
  if (lcp === null) {
    return { error: "no LCP value despite no runtimeError" };
  }
  return {
    lcp,
    cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
    fcp: audits["first-contentful-paint"]?.numericValue ?? null,
    ttfb: audits["server-response-time"]?.numericValue ?? null,
    tbt: audits["total-blocking-time"]?.numericValue ?? null,
  };
}
