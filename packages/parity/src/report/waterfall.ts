/**
 * Per-page Network waterfall renderer. Produces an SVG bar chart with
 * one row per request, positioned by `startMs` and sized by duration.
 * Color-coded by `resourceType` so doc/js/css/img/xhr each have a tint.
 * Issue #78.
 *
 * Renders nothing (returns empty string) when no request has both
 * `startMs` and `endMs` — older `report.json` files from before the
 * field was added.
 */

import type { NetworkEntry } from "../types/schema.ts";
import { escapeHtml as esc } from "./issue-html.ts";

const TYPE_COLOR: Record<string, string> = {
  document: "var(--accent-action)",
  script: "var(--state-warn)",
  stylesheet: "var(--state-info)",
  image: "var(--state-good)",
  font: "#c84df0",
  xhr: "#f0904d",
  fetch: "#f0904d",
  media: "#9999ff",
  other: "var(--text-muted)",
};

function colorFor(type: string): string {
  return TYPE_COLOR[type] ?? TYPE_COLOR.other!;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

interface WaterfallRow {
  entry: NetworkEntry;
  start: number;
  end: number;
}

/**
 * Pick rows with valid start/end timing and sort by start ascending.
 * If no rows qualify, the panel falls back to the existing duration
 * table — see callers in `render.ts`.
 */
export function buildWaterfallRows(entries: NetworkEntry[]): WaterfallRow[] {
  const rows: WaterfallRow[] = [];
  for (const e of entries) {
    if (typeof e.startMs !== "number" || typeof e.endMs !== "number") continue;
    if (e.endMs < e.startMs) continue;
    rows.push({ entry: e, start: e.startMs, end: e.endMs });
  }
  rows.sort((a, b) => a.start - b.start);
  return rows;
}

export function renderWaterfall(entries: NetworkEntry[]): string {
  const rows = buildWaterfallRows(entries);
  if (rows.length === 0) return "";

  // Trim outliers: a few very long tail requests would compress the bulk
  // into invisibility. Use the 95th percentile of `end` as the visual cap,
  // and tag truncated bars with an arrow.
  const ends = rows.map((r) => r.end).sort((a, b) => a - b);
  const p95 = ends[Math.floor(ends.length * 0.95)] ?? ends[ends.length - 1] ?? 1;
  const max = Math.max(p95, 100); // never less than 100ms range

  const ROW_H = 14;
  const LABEL_W = 280;
  const BAR_AREA = 480;
  const PADDING_X = 8;
  const HEIGHT = rows.length * ROW_H + 24;
  const WIDTH = LABEL_W + BAR_AREA + PADDING_X * 2;

  const tickStep = max <= 500 ? 100 : max <= 2000 ? 250 : max <= 5000 ? 500 : 1000;
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += tickStep) ticks.push(t);

  const bars = rows
    .map((r, i) => {
      const y = i * ROW_H + 18;
      const url = r.entry.url;
      const label = truncate(`${r.entry.resourceType} · ${url.split("?")[0]}`, 50);
      const startX = LABEL_W + PADDING_X + Math.min((r.start / max) * BAR_AREA, BAR_AREA);
      const endX = LABEL_W + PADDING_X + Math.min((r.end / max) * BAR_AREA, BAR_AREA);
      const w = Math.max(2, endX - startX);
      const truncated = r.end > max;
      const tooltip = `${r.entry.resourceType} ${r.entry.status} · ${r.entry.durationMs?.toFixed(0) ?? "?"}ms · ${url}`;
      return `
        <text x="${PADDING_X}" y="${y + 10}" class="wf-label" title="${esc(url)}">${esc(label)}</text>
        <rect x="${startX.toFixed(1)}" y="${y + 1}" width="${w.toFixed(1)}" height="${ROW_H - 4}" rx="2"
              fill="${colorFor(r.entry.resourceType)}"
              opacity="${r.entry.fromCache ? 0.55 : 0.9}">
          <title>${esc(tooltip)}</title>
        </rect>
        ${truncated ? `<text x="${(LABEL_W + PADDING_X + BAR_AREA - 4).toFixed(1)}" y="${y + 10}" class="wf-trunc">▶</text>` : ""}`;
    })
    .join("");

  const tickEls = ticks
    .map((t) => {
      const x = LABEL_W + PADDING_X + (t / max) * BAR_AREA;
      return `
        <line x1="${x.toFixed(1)}" y1="14" x2="${x.toFixed(1)}" y2="${HEIGHT - 4}" class="wf-tick"/>
        <text x="${x.toFixed(1)}" y="10" class="wf-tick-label" text-anchor="middle">${t}ms</text>`;
    })
    .join("");

  return `
    <div class="wf-wrap">
      <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMinYMin meet" class="wf-svg">
        ${tickEls}
        ${bars}
      </svg>
    </div>`;
}
