/**
 * Per-section extraction from a saved parity report. Lets agents pull
 * just the SEO tab, just the Network tab, etc. without parsing the
 * whole HTML or loading the full Run object into context. Issue #74.
 *
 * Two output modes:
 *   - `kind: "html"` — find the `<section data-panel="<name>">` block
 *     and return it verbatim. Cheapest, preserves the report's exact
 *     visual layout if the caller wants to embed it elsewhere.
 *   - `kind: "json"` — pull the corresponding slice out of `report.json`.
 *     Returns a normalized JSON payload tailored to each section so
 *     agents don't have to navigate the full Run shape.
 */

import type { Run } from "../types/schema.ts";

export type ReportSection =
  | "summary"
  | "visualdiff"
  | "seo"
  | "sidebyside"
  | "issues"
  | "vitals"
  | "cache"
  | "checks"
  | "prompt"
  | "pages"
  | "console"
  | "network"
  | "diff";

export const ALL_REPORT_SECTIONS: readonly ReportSection[] = [
  "summary",
  "visualdiff",
  "seo",
  "sidebyside",
  "issues",
  "vitals",
  "cache",
  "checks",
  "prompt",
  "pages",
  "console",
  "network",
  "diff",
];

export type ExtractInput =
  | { kind: "html"; section: ReportSection; html: string }
  | { kind: "json"; section: ReportSection; run: Run };

export function extractReportSection(input: ExtractInput): string | unknown | null {
  if (input.kind === "html") return extractHtmlSection(input.html, input.section);
  return extractJsonSection(input.run, input.section);
}

/**
 * Find the `<section data-panel="<name>">...</section>` block in the
 * full report HTML. Returns the inner-HTML (without the wrapping section
 * tag) so callers can embed it directly. Returns null if not found.
 *
 * Implementation note: HTML doesn't support nested sections in our
 * report, so a depth-aware walker isn't needed. The reliable rule is
 * "from the matching opening tag, find the closest `</section>`".
 */
function extractHtmlSection(html: string, section: ReportSection): string | null {
  const openMatch = new RegExp(`<section[^>]*\\bdata-panel=["']${section}["'][^>]*>`, "i").exec(
    html,
  );
  if (!openMatch) return null;
  const start = openMatch.index + openMatch[0].length;
  // Find the next `</section>` AFTER the opening tag.
  const close = html.indexOf("</section>", start);
  if (close < 0) return null;
  return html.slice(start, close).trim();
}

/**
 * Pull a normalized JSON projection from the full Run object. Each
 * section's shape is tailored — we don't just return `run.X` because
 * some panels combine multiple parts of the Run (e.g. `summary` mixes
 * verdict + tiles + topIssues).
 */
function extractJsonSection(run: Run, section: ReportSection): unknown | null {
  switch (section) {
    case "summary":
      return {
        runId: run.id,
        prodUrl: run.prodUrl,
        candUrl: run.candUrl,
        verdict: run.verdict,
        topIssues: run.topIssues,
        durationMs: run.durationMs,
      };
    case "visualdiff":
      return run.visualDiff ?? null;
    case "seo":
      return run.seo ?? null;
    case "issues":
      return { count: run.issues.length, issues: run.issues };
    case "vitals":
      return extractVitalsSlice(run);
    case "cache":
    case "network":
      return extractNetworkSlice(run);
    case "checks":
      return run.checks.map((c) => ({
        name: c.name,
        status: c.status,
        severity: c.severity,
        durationMs: c.durationMs,
        summary: c.summary,
        issueCount: c.issues.length,
      }));
    case "pages":
      return extractPagesSlice(run);
    case "console":
      return run.checks
        .filter((c) => c.name === "console-errors-baseline")
        .flatMap((c) => c.issues);
    case "sidebyside":
      return extractSideBySideSlice(run);
    case "prompt":
      // The prompt is generated from the run; importing the builder here
      // creates a dependency cycle. Surface the raw inputs instead — let
      // the agent rebuild the prompt with its own preferences.
      return {
        runId: run.id,
        topIssuesCount: run.topIssues.length,
        hint: "Use `parity prompt <runId>` to materialize the LLM-ready Markdown.",
      };
    case "diff":
      return run.baseline?.delta ?? null;
  }
  return null;
}

function extractVitalsSlice(run: Run): unknown {
  const out: Record<string, unknown> = {};
  for (const fc of run.flowCaptures) {
    for (const p of fc.pages) {
      if (!p.vitals) continue;
      const k = `${p.side}::${p.viewport}::${pathOf(p.url)}`;
      out[k] = p.vitals;
    }
  }
  return out;
}

function extractNetworkSlice(run: Run): unknown {
  // Aggregate cand requests with their cache decision for at-a-glance
  // status; full per-request detail lives in the page capture.
  const candRequests: Array<{
    url: string;
    status: number;
    bytes: number | null;
    fromCache: boolean;
    cacheControl: string | null;
  }> = [];
  for (const fc of run.flowCaptures) {
    for (const p of fc.pages) {
      if (p.side !== "cand") continue;
      for (const r of p.network) {
        candRequests.push({
          url: r.url,
          status: r.status,
          bytes: r.bytes ?? null,
          fromCache: r.fromCache,
          cacheControl: r.cacheControl,
        });
      }
    }
  }
  return { total: candRequests.length, requests: candRequests };
}

function extractPagesSlice(run: Run): unknown {
  const seen = new Set<string>();
  const rows: Array<{ url: string; viewport: string; side: string; status: number }> = [];
  for (const fc of run.flowCaptures) {
    for (const p of fc.pages) {
      const k = `${p.url}::${p.viewport}::${p.side}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({ url: p.url, viewport: p.viewport, side: p.side, status: p.status });
    }
  }
  return rows;
}

function extractSideBySideSlice(run: Run): unknown {
  // The side-by-side panel is purely interactive — there's no data to
  // emit. Return the URL pairs that the iframe controller would use.
  const pairs: Array<{ label: string; prodUrl: string; candUrl: string; viewport: string }> = [];
  for (const fc of run.flowCaptures) {
    for (const p of fc.pages) {
      if (p.side !== "prod") continue;
      // Find the paired cand page (same path, same viewport)
      const candPath = pathOf(p.url);
      const cand = fc.pages.find(
        (q) => q.side === "cand" && pathOf(q.url) === candPath && q.viewport === p.viewport,
      );
      if (!cand) continue;
      pairs.push({
        label: `${candPath || "/"} · ${p.viewport}`,
        prodUrl: p.url,
        candUrl: cand.url,
        viewport: p.viewport,
      });
    }
  }
  return pairs;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}
