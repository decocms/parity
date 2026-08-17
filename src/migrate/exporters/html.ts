import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { componentDirName } from "../../extract/naming.ts";
import type { MigrationBundle } from "../../types/migrate.ts";
import type { MigrateExporter } from "./types.ts";

/**
 * Self-contained `index.html` — a human-friendly visual view of the migration
 * result (theme swatches, per-viewport screenshots, brand assets, component
 * table, VTEX→FastStore map). Inline CSS, no external deps; references the
 * local `screenshots/` and `assets/` files by relative path so it works when
 * opened as a `file://` (via `parity migrate --open`).
 */
export const htmlExporter: MigrateExporter = {
  name: "html",
  async export(bundle, outDir) {
    writeFileSync(join(outDir, "index.html"), renderHtml(bundle), "utf8");
  },
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function swatch(label: string, value: string | null): string {
  if (!value) return `<div class="sw"><div class="chip empty"></div><b>${label}</b><span>—</span></div>`;
  return `<div class="sw"><div class="chip" style="background:${esc(value)}"></div><b>${label}</b><span>${esc(value)}</span></div>`;
}

function chips(items: string[]): string {
  return items.length ? items.map((i) => `<code>${esc(i)}</code>`).join(" ") : "<em>none</em>";
}

function renderHtml(b: MigrationBundle): string {
  const t = b.theme;
  const shots = (b.screenshots ?? [])
    .map((s) => `<figure><figcaption>${esc(s.viewport)}</figcaption><a href="${esc(s.path)}" target="_blank"><img src="${esc(s.path)}" alt="${esc(s.viewport)}"></a></figure>`)
    .join("");

  const componentRows = b.components
    .map((c, i) => {
      const keys = [...new Set(c.interactions.map((x) => x.e2eKey).filter(Boolean))];
      const folder = componentDirName(c.role, i + 1);
      return `<tr><td>${esc(c.scope)}</td><td><code>${esc(c.role)}</code>${c.repeated && c.repeated > 1 ? ` <span class="badge">×${c.repeated}</span>` : ""}</td><td>${c.tailwind.length}</td><td>${c.interactions.length}</td><td>${keys.length ? keys.map((k) => `<code>${esc(String(k))}</code>`).join(" ") : "—"}</td><td><a href="components/${esc(folder)}/README.md">${esc(folder)}</a></td></tr>`;
    })
    .join("");

  const vtexRows = b.vtex
    ? b.vtex.map
        .slice(0, 80)
        .map(
          (m) =>
            `<tr><td><code>${esc(m.vtex)}</code></td><td>${m.faststore ? `<code>${esc(m.faststore)}</code>` : '<em>custom-component</em>'}</td><td>${m.confidence || "—"}</td><td>${m.count}</td></tr>`,
        )
        .join("")
    : "";

  const iconRows = t && b.assets.icons.length
    ? b.assets.icons.slice(0, 40).map((ic) => `<tr><td>${esc(ic.kind)}</td><td><code>${esc(ic.id)}</code></td><td>${ic.count}</td></tr>`).join("")
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>parity migrate — ${esc(b.url)}</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e; --accent:#2f81f7; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  header { padding:24px 32px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 6px; font-size:20px; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.04em; color:var(--dim); margin:0 0 12px; }
  .meta { color:var(--dim); font-size:13px; }
  .meta code { color:var(--fg); }
  main { padding:24px 32px; max-width:1100px; margin:0 auto; display:grid; gap:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:20px; }
  .swatches { display:flex; gap:20px; flex-wrap:wrap; }
  .sw { display:flex; flex-direction:column; gap:4px; }
  .sw b { font-size:12px; } .sw span { color:var(--dim); font-size:12px; font-family:monospace; }
  .chip { width:64px; height:64px; border-radius:8px; border:1px solid var(--line); }
  .chip.empty { background:repeating-linear-gradient(45deg,#222,#222 6px,#333 6px,#333 12px); }
  figure { margin:0; } figure img { max-width:100%; border:1px solid var(--line); border-radius:8px; display:block; }
  figcaption { color:var(--dim); font-size:12px; margin-bottom:6px; text-transform:capitalize; }
  .shots { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; }
  code { background:#0b0f14; padding:1px 5px; border-radius:4px; font-size:12px; }
  a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
  .badge { background:#1f6feb33; color:#79c0ff; padding:0 6px; border-radius:10px; font-size:11px; }
  .assets { display:flex; gap:24px; align-items:center; flex-wrap:wrap; }
  .assets img { max-height:48px; max-width:200px; background:#fff; padding:6px; border-radius:6px; }
  ul.kv { list-style:none; padding:0; margin:0; display:grid; gap:6px; }
  .links a { margin-right:16px; }
  .dim { color:var(--dim); }
</style></head>
<body>
<header>
  <h1>parity migrate — ${esc(b.url)}</h1>
  <div class="meta">
    <code>${esc(b.platform)}</code>${b.target ? ` → <code>${esc(b.target)}</code>` : ""}
    · viewports: <code>${esc((b.viewports ?? [b.viewport]).join(", "))}</code>
    · pages: ${b.pages.map((p) => `<code>${esc(p.kind)}</code>`).join(" ") || "—"}
    · <span class="dim">${esc(b.timestamp)}</span>
  </div>
</header>
<main>

  <section class="card">
    <h2>Theme</h2>
    <div class="swatches">
      ${swatch("primary", t.colors.primary)}
      ${swatch("secondary", t.colors.secondary)}
      ${swatch("background", t.colors.background)}
      ${swatch("text", t.colors.text)}
    </div>
    <ul class="kv" style="margin-top:16px">
      <li><b>Fonts:</b> ${chips(t.typography.fontFamilies)}</li>
      <li><b>Font sizes:</b> ${chips(t.typography.sizeScale)}</li>
      <li><b>Spacing:</b> ${chips(t.spacingScale)}</li>
      <li><b>Radii:</b> ${chips(t.radii)}</li>
      <li><b>Breakpoints:</b> ${chips(t.breakpoints)}</li>
      <li><b>Motion:</b> ${chips([...t.motion.durations, ...t.motion.easings])}</li>
    </ul>
  </section>

  ${shots ? `<section class="card"><h2>Screenshots by viewport</h2><div class="shots">${shots}</div></section>` : ""}

  <section class="card">
    <h2>Brand assets</h2>
    <div class="assets">
      ${b.assets.logo ? `<div><div class="dim">logo</div><img src="${esc(b.assets.logo)}" alt="logo"></div>` : '<span class="dim">no logo</span>'}
      ${b.assets.favicon ? `<div><div class="dim">favicon</div><img src="${esc(b.assets.favicon)}" alt="favicon" style="max-height:32px"></div>` : ""}
      <div class="dim">${b.assets.icons.length} icons · ${b.assets.fonts.length} web fonts</div>
    </div>
    ${iconRows ? `<table style="margin-top:16px"><tr><th>kind</th><th>id</th><th>count</th></tr>${iconRows}</table>` : ""}
  </section>

  ${b.vtex ? `<section class="card"><h2>VTEX IO → FastStore blocks</h2><p class="dim">${b.vtex.blocks.length} block instances from the store runtime.</p><table><tr><th>VTEX block</th><th>→ FastStore</th><th>confidence</th><th>count</th></tr>${vtexRows}</table></section>` : ""}

  <section class="card">
    <h2>Components (${b.components.length})</h2>
    <table>
      <tr><th>scope</th><th>role</th><th>tw</th><th>interactions</th><th>e2e keys</th><th>folder</th></tr>
      ${componentRows}
    </table>
  </section>

  <section class="card links">
    <h2>Files</h2>
    <a href="MIGRATION_PROMPT.md">MIGRATION_PROMPT.md</a>
    <a href="index.md">index.md</a>
    ${b.target === "faststore" ? '<a href="custom-theme.scss">custom-theme.scss</a>' : ""}
    ${b.vtex ? '<a href="component-map.json">component-map.json</a> <a href="blocks.json">blocks.json</a>' : ""}
    <a href="manifest.json">manifest.json (full)</a>
  </section>

</main></body></html>`;
}
