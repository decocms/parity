import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { componentDirName } from "../../extract/naming.ts";
import type { MigrationBundle } from "../../types/migrate.ts";
import { getTargetTheme } from "../targets/index.ts";
import { countContentImages } from "../vtex/content-assets.ts";
import type { MigrateExporter } from "./types.ts";

/** How an image path is turned into an `<img src>` value. */
type Embed = (relPath: string | null | undefined) => string | null;

/**
 * Human-friendly visual view of the migration result (theme swatches,
 * per-viewport screenshots, brand assets, component table, VTEX→FastStore map).
 * Inline CSS, no external deps.
 *
 * Two outputs:
 *  - `index.html` — references local `screenshots/`/`assets/` by relative path
 *    (lighter; for local viewing via `--open`).
 *  - `report.html` — a **single self-contained file** with every image inlined
 *    as a base64 data URI, so it can be uploaded/shared as one link.
 */
export const htmlExporter: MigrateExporter = {
  name: "html",
  async export(bundle, outDir) {
    // index.html — referenced paths.
    writeFileSync(join(outDir, "index.html"), renderHtml(bundle, (p) => p ?? null), "utf8");
    // report.html — everything inlined as data URIs.
    const inline: Embed = (p) => (p ? dataUri(join(outDir, p)) ?? p : null);
    writeFileSync(join(outDir, "report.html"), renderHtml(bundle, inline), "utf8");
  },
};

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Read a local image and return a base64 data URI, or null if unreadable. */
function dataUri(absPath: string): string | null {
  try {
    const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase();
    const mime = MIME[ext];
    if (!mime) return null;
    return `data:${mime};base64,${readFileSync(absPath).toString("base64")}`;
  } catch {
    return null;
  }
}

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

/** Domain shown in the cover, from the crawled URL. */
function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function chips(items: string[]): string {
  return items.length ? items.map((i) => `<code>${esc(i)}</code>`).join(" ") : "<em>none</em>";
}

/** Header verdict: the sharp stack (deco-fresh + htmx · commerce) over the coarse platform. */
function stackMeta(b: MigrationBundle): string {
  const s = b.stack;
  if (!s || s.frontend === "unknown") return `<code>${esc(b.platform)}</code>`;
  const fe = `<code>${esc(s.frontend)}${s.htmx ? " + htmx" : ""}</code>`;
  const commerce =
    s.commerce !== "unknown" && s.commerce !== s.frontend
      ? ` · commerce: <code>${esc(s.commerce)}</code>`
      : "";
  return fe + commerce;
}

/** What the capture was paired with — the repo (`--source`) or a live-only scrape. */
function sourceMeta(b: MigrationBundle): string {
  const src = b.source;
  if (!src || src.kind === "live-only")
    return `source: <code>live capture</code> <span class="dim">(no repo)</span>`;
  return `source: <code>${esc(src.kind)}</code>${src.dir ? ` <code>${esc(src.dir)}</code>` : ""}`;
}

function renderHtml(b: MigrationBundle, embed: Embed): string {
  const t = b.theme;
  const shots = (b.screenshots ?? [])
    .map((s) => {
      const src = embed(s.path);
      // Full-page capture shown inside a scrollable device frame (the whole
      // page is tall — the frame keeps it phone-sized and scrollable in place).
      const mobile = /mobile|phone/i.test(s.viewport);
      return src
        ? `<figure><figcaption>${esc(s.viewport)}</figcaption><div class="device ${mobile ? "phone" : "wide"}"><img src="${esc(src)}" alt="${esc(s.viewport)}"></div></figure>`
        : "";
    })
    .join("");

  // Folder index per component (stable across fresh/cache runs via role+selector).
  const compIndex = new Map<string, number>();
  b.components.forEach((c, i) => compIndex.set(`${c.role}::${c.selector}`, i + 1));
  const compHead = "<tr><th>role</th><th>tw</th><th>interactions</th><th>e2e keys</th><th>folder</th></tr>";
  const rowFor = (c: MigrationBundle["components"][number]): string => {
    const keys = [...new Set(c.interactions.map((x) => x.e2eKey).filter(Boolean))];
    const folder = componentDirName(c.role, compIndex.get(`${c.role}::${c.selector}`) ?? 1);
    return `<tr><td><code>${esc(c.role)}</code>${c.repeated && c.repeated > 1 ? ` <span class="badge">×${c.repeated}</span>` : ""}</td><td>${c.tailwind.length}</td><td>${c.interactions.length}</td><td>${keys.length ? keys.map((k) => `<code>${esc(String(k))}</code>`).join(" ") : "—"}</td><td><a href="components/${esc(folder)}/README.md">${esc(folder)}</a></td></tr>`;
  };
  const globalComps = b.components.filter((c) => c.scope === "global");
  const componentsByPage = [
    `<section class="card"><h2>Global components (${globalComps.length})</h2><p class="dim">Captured once — shown on every page (header, footer, minicart…).</p><table>${compHead}${globalComps.map(rowFor).join("")}</table></section>`,
    ...b.pages.map(
      (pg) =>
        `<section class="card"><h2>Page: ${esc(pg.kind)} <code>${esc(pg.path)}</code></h2>${pg.components.length ? `<table>${compHead}${pg.components.map(rowFor).join("")}</table>` : '<p class="dim">no page-specific components</p>'}</section>`,
    ),
  ].join("");

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

  const favSrc = embed(b.assets.favicon);
  const logoSrc = embed(b.assets.logo);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>parity migrate — ${esc(domainOf(b.url))}</title>
${favSrc ? `<link rel="icon" href="${esc(favSrc)}">` : ""}
<style>
  :root { --bg:#ffffff; --ink:#282524; --muted:#78726e; --faint:#a6a09d;
    --border:rgba(40,37,36,0.09); --card:rgba(40,37,36,0.06); --soft:#8caa25; --forest:#07401a; }
  * { box-sizing:border-box; }
  html { background:#e9e7e3; }
  body { margin:0; color:var(--ink); background:var(--bg);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased; max-width:1080px; margin:0 auto; }
  .num { font-family:Georgia,"Times New Roman",serif; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; }
  .eyebrow { font-size:11px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--soft); }
  header { padding:44px 20px 26px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:20px; }
  header .brand-logo { max-height:52px; max-width:200px; background:#fff; border:1px solid var(--card);
    border-radius:10px; padding:8px 12px; object-fit:contain; }
  header .brand-fav { width:38px; height:38px; border-radius:9px; border:1px solid var(--card); background:#fff; padding:5px; object-fit:contain; }
  header .htxt { display:flex; flex-direction:column; gap:6px; }
  h1 { margin:0; font-size:clamp(1.6rem,4vw,2.2rem); font-weight:400; letter-spacing:-0.02em; }
  h2 { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--soft); margin:0 0 14px; }
  .meta { color:var(--muted); font-size:13px; }
  .meta code { color:var(--ink); }
  main { padding:24px 20px 80px; display:grid; gap:20px; }
  .card { background:#fff; border:1px solid var(--card); border-radius:16px; padding:24px; }
  .swatches { display:flex; gap:20px; flex-wrap:wrap; }
  .sw { display:flex; flex-direction:column; gap:4px; }
  .sw b { font-size:12px; } .sw span { color:var(--muted); font-size:12px; font-family:monospace; }
  .chip { width:64px; height:64px; border-radius:10px; border:1px solid var(--border); }
  .chip.empty { background:repeating-linear-gradient(45deg,#f4f2ef,#f4f2ef 6px,#e9e7e3 6px,#e9e7e3 12px); }
  figure { margin:0; } figure img { max-width:100%; border:1px solid var(--card); border-radius:12px; display:block;
    box-shadow:0 1px 2px rgba(40,37,36,0.04),0 12px 34px rgba(40,37,36,0.08); }
  figcaption { color:var(--muted); font-size:12px; margin-bottom:6px; text-transform:capitalize; }
  .shots { display:flex; flex-wrap:wrap; gap:20px; }
  .device { overflow:auto; background:#fff; border:9px solid #1c1c1c; border-radius:30px;
    box-shadow:0 10px 30px rgba(40,37,36,0.14); }
  .device::-webkit-scrollbar { width:8px; } .device::-webkit-scrollbar-thumb { background:#cfccc8; border-radius:8px; }
  .device.phone { width:340px; height:640px; }
  .device.wide { width:520px; height:640px; }
  .device img { width:100%; display:block; border:0; border-radius:0; box-shadow:none; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  code { background:#f4f2ef; padding:1px 6px; border-radius:5px; font-size:12px; color:var(--ink); }
  a { color:var(--forest); text-decoration:none; } a:hover { text-decoration:underline; }
  .badge { background:var(--soft); color:#fff; padding:0 7px; border-radius:999px; font-size:11px; font-weight:600; }
  .assets { display:flex; gap:24px; align-items:center; flex-wrap:wrap; }
  .assets img { max-height:48px; max-width:200px; background:#fff; padding:6px; border-radius:8px; border:1px solid var(--card); }
  ul.kv { list-style:none; padding:0; margin:0; display:grid; gap:6px; }
  .links a { margin-right:16px; }
  .dim { color:var(--muted); }
</style></head>
<body>
<header>
  ${logoSrc ? `<img class="brand-logo" src="${esc(logoSrc)}" alt="logo">` : favSrc ? `<img class="brand-fav" src="${esc(favSrc)}" alt="favicon">` : ""}
  <div class="htxt">
    <span class="eyebrow">Parity · Migration</span>
    <h1>${esc(domainOf(b.url))}</h1>
    <div class="meta">
      <code>${esc(b.url)}</code> ·
      ${stackMeta(b)}${b.target ? ` → <code>${esc(b.target)}</code>` : ""}
      · ${sourceMeta(b)}
      · viewports: <code>${esc((b.viewports ?? [b.viewport]).join(", "))}</code>
      · pages: ${b.pages.map((p) => `<code>${esc(p.kind)}</code>`).join(" ") || "—"}
      · <span class="dim">${esc(b.timestamp)}</span>
    </div>
  </div>
</header>
<main>

  <section class="card">
    <h2>Theme <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">· extracted from the live page</span></h2>
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
      ${(() => { const s = embed(b.assets.logo); return s ? `<div><div class="dim">logo</div><img src="${esc(s)}" alt="logo"></div>` : '<span class="dim">no logo</span>'; })()}
      ${(() => { const s = embed(b.assets.favicon); return s ? `<div><div class="dim">favicon</div><img src="${esc(s)}" alt="favicon" style="max-height:32px"></div>` : ""; })()}
      <div class="dim">${b.assets.icons.length} icons · ${b.assets.fontFiles.length}/${b.assets.fonts.length} web fonts downloaded${b.assets.fontFiles.length ? " → assets/fonts/" : ""}</div>
    </div>
    ${iconRows ? `<table style="margin-top:16px"><tr><th>kind</th><th>id</th><th>count</th></tr>${iconRows}</table>` : ""}
  </section>

  ${b.vtex ? `<section class="card"><h2>VTEX IO → FastStore blocks</h2><p class="dim">${b.vtex.blocks.length} block instances from the store runtime · ${b.vtex.blocks.filter((x) => x.props).length} carry CMS content (props), ${countContentImages(b.vtex.blocks)} content images downloaded to <code>assets/content/</code> (URLs rewritten in <code>blocks.json</code>). <b>confidence</b> = how sure the deterministic mapper is (0–1).</p><table><tr><th>VTEX block</th><th>→ FastStore</th><th>confidence</th><th>count</th></tr>${vtexRows}</table></section>` : ""}

  <section class="card"><h2>Components (${b.components.length})</h2><p class="dim">${globalComps.length} global · ${b.components.length - globalComps.length} page-specific, grouped by page below.</p></section>
  ${componentsByPage}

  <section class="card links">
    <h2>Files</h2>
    <a href="MIGRATION_PROMPT.md">MIGRATION_PROMPT.md</a>
    <a href="index.md">index.md</a>
    ${themeLink(b.target)}
    ${b.vtex ? '<a href="component-map.json">component-map.json</a> <a href="blocks.json">blocks.json</a>' : ""}
    <a href="manifest.json">manifest.json (full)</a>
  </section>

</main></body></html>`;
}

/**
 * Link to whichever starter theme the target declared. Was hardcoded to the v4 filename and gated
 * on the v4 target, so the other targets' theme files were written and then never linked (#309).
 */
function themeLink(target: string | undefined | null): string {
  const theme = target ? getTargetTheme(target) : null;
  if (!theme) return "";
  return `<a href="${theme.filename}">${theme.filename}</a>`;
}
