// Reusable Lighthouse runner — a fresh `npx lighthouse` process per page with
// real (not simulated) mobile throttling (Slow 4G + 4x CPU) via
// `--throttling-method=devtools`. Used by `parity benchmark` for the cold
// first-visit Web Vitals pass (originally extracted from the FARM Rio vitals
// spike, since removed).
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
import type { AgentA11yAudit, LhOpportunity, LhScores } from "../types/schema.ts";

export type { AgentA11yAudit, LhOpportunity, LhScores };

export interface LhSample {
  lcp: number | null;
  cls: number | null;
  fcp: number | null;
  ttfb: number | null;
  tbt: number | null;
  /** Actionable audits (render-block, unused JS, lazy LCP, oversized images…). */
  opportunities?: LhOpportunity[];
  /** Category scores (performance/accessibility/best-practices/seo), 0..100. */
  scores?: LhScores;
  /** Agent-relevant accessibility-tree audits (for "Navegação agêntica"). */
  agentA11y?: AgentA11yAudit[];
}

// Accessibility-tree audits that matter most for an AI agent parsing/operating a
// page: it needs discernible names for interactive elements and labeled inputs.
// These are a curated subset of Lighthouse's accessibility category. #264.
const AGENT_A11Y_AUDIT_IDS = [
  "button-name",
  "link-name",
  "label",
  "image-alt",
  "input-image-alt",
  "select-name",
  "aria-required-attr",
  "aria-valid-attr",
  "aria-valid-attr-value",
  "aria-command-name",
  "aria-input-field-name",
  "aria-toggle-field-name",
  "form-field-multiple-labels",
] as const;

/** Extract the agent-relevant a11y audits (with a few failing element samples). */
function extractAgentA11y(audits: Record<string, LhAudit>): AgentA11yAudit[] {
  const out: AgentA11yAudit[] = [];
  for (const id of AGENT_A11Y_AUDIT_IDS) {
    const a = audits[id];
    if (!a) continue;
    const score = typeof a.score === "number" ? a.score : null;
    const elements = (a.details?.items ?? [])
      .map((it) => it?.node)
      .filter((n): n is { selector?: string; snippet?: string } => !!n)
      .slice(0, 5)
      .map((n) => ({ selector: n.selector ?? "", snippet: n.snippet ?? "" }));
    out.push({ id, title: a.title ?? id, score, elements });
  }
  return out;
}

// Curated set of actionable audits worth reporting even when Lighthouse doesn't
// tag them as an "opportunity" (some are diagnostics). Anything with a real
// overallSavingsMs/Bytes is picked up generically regardless of this list.
const ACTIONABLE_AUDIT_IDS = new Set([
  "render-blocking-resources",
  "unused-javascript",
  "unused-css-rules",
  "unminified-javascript",
  "unminified-css",
  "uses-responsive-images",
  "uses-optimized-images",
  "modern-image-formats",
  "offscreen-images",
  "uses-rel-preconnect",
  "uses-rel-preload",
  "server-response-time",
  "redirects",
  "legacy-javascript",
  "font-display",
  "lcp-lazy-loaded",
  "prioritize-lcp-image",
  "total-byte-weight",
  "dom-size",
  "bootup-time",
  "mainthread-work-breakdown",
  "third-party-summary",
]);

/** Extract actionable audits from a Lighthouse report's `audits` map. */
function extractOpportunities(
  audits: Record<string, LhAudit>,
  minSavingsMs = 50,
): LhOpportunity[] {
  const out: LhOpportunity[] = [];
  for (const [id, a] of Object.entries(audits)) {
    if (!a) continue;
    const savingsMs = a.details?.overallSavingsMs ?? a.numericValue ?? 0;
    const savingsBytes = a.details?.overallSavingsBytes ?? 0;
    const scored = typeof a.score === "number" && a.score < 0.9;
    const hasSavings = (a.details?.overallSavingsMs ?? 0) >= minSavingsMs || savingsBytes > 0;
    const curated = ACTIONABLE_AUDIT_IDS.has(id) && (scored || hasSavings);
    if (!hasSavings && !curated) continue;
    out.push({
      id,
      title: a.title ?? id,
      savingsMs: Math.round(a.details?.overallSavingsMs ?? 0),
      savingsBytes: Math.round(savingsBytes),
      displayValue: a.displayValue,
      score: typeof a.score === "number" ? a.score : null,
    });
  }
  // Biggest wins first (ms, then bytes).
  return out.sort((x, y) => y.savingsMs - x.savingsMs || y.savingsBytes - x.savingsBytes);
}

interface LhAudit {
  title?: string;
  score?: number | null;
  numericValue?: number;
  displayValue?: string;
  details?: {
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
    items?: Array<{ node?: { selector?: string; snippet?: string } }>;
  };
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
    // performance + the three static-ish categories Lighthouse computes in the
    // same run (accessibility/best-practices/seo are mostly DOM audits — cheap
    // relative to the perf trace already running). #264.
    "--only-categories=performance,accessibility,best-practices,seo",
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
    audits: Record<string, LhAudit>;
    categories?: Record<string, { score?: number | null }>;
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
  // Lighthouse scores are 0..1; surface as 0..100 to match PageSpeed's UI.
  const cat = report.categories ?? {};
  const pct = (c?: { score?: number | null }): number | null =>
    typeof c?.score === "number" ? Math.round(c.score * 100) : null;
  return {
    lcp,
    cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
    fcp: audits["first-contentful-paint"]?.numericValue ?? null,
    ttfb: audits["server-response-time"]?.numericValue ?? null,
    tbt: audits["total-blocking-time"]?.numericValue ?? null,
    opportunities: extractOpportunities(audits),
    scores: {
      performance: pct(cat.performance),
      accessibility: pct(cat.accessibility),
      bestPractices: pct(cat["best-practices"]),
      seo: pct(cat.seo),
    },
    agentA11y: extractAgentA11y(audits),
  };
}
