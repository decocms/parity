import { writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { HeatmapAnalysis } from "./heatmap-regions.ts";
import type { CssSource } from "../engine/css-source-resolver.ts";
import type {
  ComputedStylesNotFound,
  ComputedStylesResult,
} from "../engine/computed-styles.ts";
import { SECTION_STYLE_KEYS } from "../engine/computed-styles.ts";

/**
 * Per-section diff bundle assembler — turns all the signals collected
 * by `parity section` / `parity fix` (HTML diff + screenshots +
 * computed styles + heatmap analysis + CSS sources) into:
 *
 *   1. A structured JSON file for programmatic consumers
 *   2. A Markdown file with embedded image refs and opinionated
 *      instructions for the LLM
 *
 * The Markdown is the user-facing artifact; the JSON is a stable
 * machine-readable shape that downstream tools (cubic, CI, our own
 * `--llm-summary` mode) can read without re-parsing prose.
 *
 * Critical design choice: the markdown asks the LLM to first SUMMARIZE
 * what it understood from the signals BEFORE writing any code. This is
 * the workflow the user explicitly asked for — confirm understanding,
 * then ask for the patch in a follow-up turn.
 */

export interface BundleInputs {
  /** CSS selector for the section under review. */
  selector: string;
  /** Pair-key like `/::mobile` if available. */
  pageKey?: string;
  /** Viewport label. */
  viewport: string;
  /** Production URL the section was captured from. */
  prodUrl: string;
  /** Candidate URL the section was captured from. */
  candUrl: string;
  /** Prettier-formatted HTML for each side and unified diff text. */
  html?: {
    prod: string;
    cand: string;
    diffPatch: string;
  };
  /** Screenshot paths per side. */
  screenshots?: {
    prodPath: string;
    candPath: string;
    /** Heatmap PNG (pixelmatch output). */
    heatmapPath?: string;
  };
  /** Bounding-box analysis of the heatmap. */
  heatmap?: HeatmapAnalysis;
  /** Computed styles per side (matches the SECTION_STYLE_KEYS list). */
  computedStyles?: {
    prod: ComputedStylesResult | ComputedStylesNotFound;
    cand: ComputedStylesResult | ComputedStylesNotFound;
  };
  /** CSS source per property name (only for properties that diverged). */
  cssSources?: {
    prod: Map<string, CssSource | null>;
    cand: Map<string, CssSource | null>;
  };
  /** Where to write the JSON + Markdown files. Must be writable. */
  outDir: string;
  /** Stable filename prefix — usually derived from a hash of the selector. */
  filePrefix: string;
}

export interface BundleOutput {
  jsonPath: string;
  markdownPath: string;
  /** A 1-line summary printed by the CLI (used in stdout). */
  summary: string;
}

export interface StyleDelta {
  property: string;
  prod: string;
  cand: string;
  prodSource: CssSource | null;
  candSource: CssSource | null;
}

export function buildStyleDeltas(input: BundleInputs): StyleDelta[] {
  const cs = input.computedStyles;
  if (!cs) return [];
  const prod = cs.prod;
  const cand = cs.cand;
  if (!("found" in prod) || !("found" in cand) || !prod.found || !cand.found) return [];
  const deltas: StyleDelta[] = [];
  for (const key of SECTION_STYLE_KEYS) {
    const p = prod.styles[key] ?? "";
    const c = cand.styles[key] ?? "";
    if (p === c) continue;
    deltas.push({
      property: key,
      prod: p,
      cand: c,
      prodSource: input.cssSources?.prod.get(key) ?? null,
      candSource: input.cssSources?.cand.get(key) ?? null,
    });
  }
  return deltas;
}

export function assembleSectionDiffBundle(input: BundleInputs): BundleOutput {
  const styleDeltas = buildStyleDeltas(input);
  const json = {
    selector: input.selector,
    pageKey: input.pageKey ?? null,
    viewport: input.viewport,
    prodUrl: input.prodUrl,
    candUrl: input.candUrl,
    html: input.html
      ? {
          // Don't write the full prod/cand HTML into JSON — it can be
          // 100KB+ per side. Just the diff (which the LLM needs) and
          // a length marker for forensics.
          diffPatch: input.html.diffPatch,
          prodHtmlBytes: input.html.prod.length,
          candHtmlBytes: input.html.cand.length,
        }
      : null,
    screenshots: input.screenshots ?? null,
    heatmap: input.heatmap ?? null,
    boundingRects: styleResultsToRects(input.computedStyles),
    styleDeltas,
  };
  const jsonPath = join(input.outDir, `${input.filePrefix}-bundle.json`);
  writeFileSync(jsonPath, `${JSON.stringify(json, mapReplacer, 2)}\n`, "utf8");

  const markdown = renderMarkdownBundle(input, styleDeltas);
  const markdownPath = join(input.outDir, `${input.filePrefix}-prompt.md`);
  writeFileSync(markdownPath, markdown, "utf8");

  const summary = oneLineSummary(input, styleDeltas);
  return { jsonPath, markdownPath, summary };
}

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

function styleResultsToRects(
  cs: BundleInputs["computedStyles"],
): { prod: unknown; cand: unknown } | null {
  if (!cs) return null;
  const p = cs.prod;
  const c = cs.cand;
  if (!("found" in p) || !("found" in c) || !p.found || !c.found) return null;
  return { prod: p.rect, cand: c.rect };
}

function oneLineSummary(input: BundleInputs, deltas: StyleDelta[]): string {
  const parts: string[] = [];
  if (input.heatmap && input.heatmap.diffPixels > 0) {
    const pct = (input.heatmap.pctDiff * 100).toFixed(1);
    parts.push(`${pct}% pixels differ`);
  }
  if (deltas.length > 0) parts.push(`${deltas.length} style delta(s)`);
  if (input.html?.diffPatch) {
    const diffLines = input.html.diffPatch
      .split("\n")
      .filter((l) => /^[-+](?![-+])/.test(l)).length;
    if (diffLines > 0) parts.push(`${diffLines} HTML line(s) changed`);
  }
  if (parts.length === 0) return "no diffs detected for this section";
  return parts.join(" · ");
}

function renderMarkdownBundle(input: BundleInputs, deltas: StyleDelta[]): string {
  const lines: string[] = [];
  const md = lines.push.bind(lines);

  // Section heading + opinionated framing.
  md(`# Pixel-perfect fix request: \`${input.selector}\``);
  md("");
  md('You are reviewing a migrated page. The **"prod"** version is the');
  md('source of truth. The **"cand"** version has divergences that need');
  md("to be fixed. Your job is to identify the smallest possible change");
  md("to make `cand` match `prod` for this section.");
  md("");
  md("## Section identification");
  md(`- **Selector**: \`${input.selector}\``);
  if (input.pageKey) md(`- **Page**: \`${input.pageKey}\``);
  md(`- **Viewport**: ${input.viewport}`);
  md(`- **prod URL**: ${input.prodUrl}`);
  md(`- **cand URL**: ${input.candUrl}`);
  md("");

  // Visual diff with embedded images
  if (input.screenshots || input.heatmap) {
    md("## Visual diff");
    if (input.heatmap) {
      const pct = (input.heatmap.pctDiff * 100).toFixed(2);
      md(`- **${pct}% of pixels differ** (${input.heatmap.diffPixels} / ${input.heatmap.imageWidth * input.heatmap.imageHeight})`);
      if (input.heatmap.boundingBox) {
        const bb = input.heatmap.boundingBox;
        md(`- Bounding box of divergence: \`x=${bb.x} y=${bb.y} w=${bb.width} h=${bb.height}\``);
      }
      if (input.heatmap.hotspots.length > 0) {
        md("- Hotspots (top regions by area):");
        for (const h of input.heatmap.hotspots.slice(0, 5)) {
          md(`  - \`(${h.x}, ${h.y}) ${h.width}×${h.height}\` — ${h.pixelCount} px`);
        }
      }
    }
    if (input.screenshots) {
      md("");
      md("**prod** (source of truth):");
      md(`![prod](${relativeOrAbs(input.outDir, input.screenshots.prodPath)})`);
      md("");
      md("**cand** (needs to match prod):");
      md(`![cand](${relativeOrAbs(input.outDir, input.screenshots.candPath)})`);
      if (input.screenshots.heatmapPath) {
        md("");
        md("**Heatmap** (red = differs):");
        md(`![heatmap](${relativeOrAbs(input.outDir, input.screenshots.heatmapPath)})`);
      }
    }
    md("");
  }

  // Layout/bbox comparison
  const cs = input.computedStyles;
  if (cs && "found" in cs.prod && "found" in cs.cand && cs.prod.found && cs.cand.found) {
    const pr = cs.prod.rect;
    const cr = cs.cand.rect;
    if (pr && cr && (pr.width !== cr.width || pr.height !== cr.height)) {
      md("## Layout");
      md(`- prod section box: ${pr.width}×${pr.height} at (${pr.x}, ${pr.y})`);
      md(`- cand section box: ${cr.width}×${cr.height} at (${cr.x}, ${cr.y})`);
      const dw = cr.width - pr.width;
      const dh = cr.height - pr.height;
      if (dw !== 0) md(`  - cand width Δ = ${dw > 0 ? "+" : ""}${dw}px`);
      if (dh !== 0) md(`  - cand height Δ = ${dh > 0 ? "+" : ""}${dh}px`);
      md("");
    }
  }

  // Computed styles deltas with CSS source
  if (deltas.length > 0) {
    md("## Computed-styles deltas");
    md("");
    md("| Property | prod | cand | Likely source |");
    md("|---|---|---|---|");
    for (const d of deltas) {
      const source = formatSource(d.candSource);
      md(`| \`${d.property}\` | \`${truncate(d.prod, 60)}\` | \`${truncate(d.cand, 60)}\` | ${source} |`);
    }
    md("");
  }

  // HTML diff
  if (input.html?.diffPatch) {
    md("## HTML diff");
    md("");
    md("```diff");
    // Cap the diff so very long sections don't blow up the LLM context.
    const cappedDiff = capDiff(input.html.diffPatch, 200);
    md(cappedDiff);
    md("```");
    md("");
  }

  // Closing instruction — the opinionated part
  md("## What I want you to do");
  md("");
  md("**Step 1: confirm understanding (this turn).** In ONE paragraph,");
  md("summarize what you see:");
  md("- What is the most visible difference in the heatmap?");
  md("- Which CSS property is most likely responsible?");
  md("- Which file/component would you edit?");
  md("");
  md("Do **NOT** write code yet. Just confirm what you understood.");
  md("");
  md("**Step 2 (next turn, after I confirm).** I will ask you to write");
  md("the patch. Plan to make the smallest change possible. Reuse");
  md("existing utilities/classes when the diff suggests it; avoid net-new");
  md("CSS rules unless absolutely needed.");
  md("");

  return lines.join("\n");
}

function relativeOrAbs(outDir: string, absPath: string): string {
  try {
    // Use relative when both paths share the same dir tree — that's the
    // markdown-renders-locally case. Otherwise fall back to absolute
    // (still works in VS Code's preview).
    if (dirname(absPath) === outDir) return basename(absPath);
    return relative(outDir, absPath);
  } catch {
    return absPath;
  }
}

function formatSource(s: CssSource | null): string {
  if (!s) return "_(no rule found / user-agent default)_";
  const tag = s.important ? " **!important**" : "";
  const inh = s.inheritedFromDistance > 0 ? " _(inherited)_" : "";
  return `\`${s.selector}\` in ${s.source}${tag}${inh}`;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function capDiff(diff: string, maxLines: number): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  const kept = lines.slice(0, maxLines);
  kept.push("");
  kept.push(`... [${lines.length - maxLines} more lines truncated]`);
  return kept.join("\n");
}
