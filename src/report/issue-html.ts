/**
 * Shared HTML helpers for rendering `Issue` objects.
 *
 * Single source of truth for severity badges, page labels, and the
 * issue card layout. Used by:
 *   - `src/report/render.ts` (the comparative prod×cand report)
 *   - `src/report/audit-render.ts` (the single-site audit report)
 *
 * Before this module, render.ts had a private `renderIssue(issue, runDir)`
 * that the comparative report called from 5 places, plus a simpler
 * duplicate inlined in audit-render.ts. Both did 90% of the same work.
 * The shared function now handles both: when `runDir` is omitted,
 * screenshot evidence is silently skipped (audit doesn't have evidence
 * paths yet).
 */

import { relative } from "node:path";
import type { Issue } from "../types/schema.ts";

/** HTML-escape a value safely (handles null, number, undefined). */
export function escapeHtml(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Build a path relative to `runDir`. Empty string when `absPath` is missing. */
export function relPath(runDir: string, absPath: string | undefined): string {
  if (!absPath) return "";
  try {
    return relative(runDir, absPath);
  } catch {
    return absPath;
  }
}

/**
 * Turn a pair-key like `/::mobile` or `/vale-presente::desktop` into a
 * human-readable label: `Home · mobile` / `/vale-presente · desktop`.
 */
export function humanKey(key: string): string {
  const parts = key.split("::");
  const path = parts[0] ?? key;
  const viewport = parts[1] ?? "";
  const niceName = path === "/" || path === "" ? "Home" : path;
  return viewport ? `${niceName} · ${viewport}` : niceName;
}

export interface RenderIssueOptions {
  /**
   * Absolute path of the run directory. Required when the issue carries
   * screenshot evidence so paths in `<img src>` are relative. Pass
   * `undefined` (audit case) to skip the evidence block entirely.
   */
  runDir?: string;
}

/**
 * Render an `Issue` as the standalone HTML card used in every parity
 * report. Composition (in order):
 *   - severity / category / check / page tags
 *   - summary (`<h3>`)
 *   - optional `<details>` blocks: Details, Reproduction, Suggested fix
 *   - optional screenshot grid when both `evidence` and `runDir` are set
 *
 * Behavior is identical to the legacy private `renderIssue` in render.ts;
 * the only addition is the `runDir`-optional branch.
 */
export function renderIssueHtml(issue: Issue, opts: RenderIssueOptions = {}): string {
  const runDir = opts.runDir;

  // Screenshots: only when both runDir AND evidence are present. Audit
  // mode doesn't produce evidence with paths, so this block silently
  // collapses to "".
  const evidenceHtml =
    runDir && issue.evidence
      ? issue.evidence
          .filter((e) => e.kind === "screenshot")
          .map(
            (e) =>
              `<figure><img src="${escapeHtml(relPath(runDir, e.path))}" alt="${escapeHtml(e.label ?? "")}" loading="lazy"/><figcaption>${escapeHtml(e.label ?? "")}</figcaption></figure>`,
          )
          .join("")
      : "";

  const pageLabel = issue.page ? humanKey(issue.page) : "";

  const details = issue.details ?? "";
  // Heuristic from the legacy renderIssue: bullet-listed or long-paragraph
  // details start collapsed; short ones auto-open so the user doesn't have
  // to click through every single issue.
  const detailsIsList = /\n\s*-\s|^\s*-\s/.test(details) || details.split("\n").length > 4;

  return `
  <div class="issue sev-${issue.severity}">
    <div class="issue-tags">
      <span class="tag sev-${issue.severity}">${escapeHtml(issue.severity)}</span>
      <span class="tag">${escapeHtml(issue.category)}</span>
      <span class="tag tag-mono">${escapeHtml(issue.check)}</span>
      ${pageLabel ? `<span class="tag tag-page">${escapeHtml(pageLabel)}</span>` : ""}
    </div>
    <h3>${escapeHtml(issue.summary)}</h3>
    ${
      issue.details
        ? `<details class="issue-section" ${detailsIsList ? "" : "open"}>
        <summary><span class="section-label">Details</span><button class="copy-btn" data-copy-target="issue-d-${escapeHtml(issue.id)}">copy</button></summary>
        <pre class="details" id="issue-d-${escapeHtml(issue.id)}">${escapeHtml(issue.details)}</pre>
      </details>`
        : ""
    }
    ${
      issue.reproduction
        ? `<details class="issue-section">
        <summary><span class="section-label">Reproduction</span><button class="copy-btn" data-copy-target="issue-r-${escapeHtml(issue.id)}">copy</button></summary>
        <pre class="repro" id="issue-r-${escapeHtml(issue.id)}">${escapeHtml(issue.reproduction)}</pre>
      </details>`
        : ""
    }
    ${
      issue.suggestedFix
        ? `<details class="issue-section" open>
        <summary><span class="section-label">Suggested fix</span><button class="copy-btn" data-copy-target="issue-f-${escapeHtml(issue.id)}">copy</button></summary>
        <pre class="fix" id="issue-f-${escapeHtml(issue.id)}">${escapeHtml(issue.suggestedFix)}</pre>
      </details>`
        : ""
    }
    ${evidenceHtml ? `<details class="issue-section"><summary><span class="section-label">Screenshots (${(issue.evidence ?? []).length})</span></summary><div class="ss-pair">${evidenceHtml}</div></details>` : ""}
  </div>`;
}
