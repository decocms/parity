import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { componentDirName } from "../../extract/naming.ts";
import { countContentImages } from "../vtex/content-assets.ts";
import type { MigratedComponent, MigrationBundle, ThemeBundle } from "../../types/migrate.ts";
import { compactComponentHtml } from "../bundle.ts";
import type { MigrateExporter } from "./types.ts";

/**
 * LEAN artifact — what the migration agent actually reads. Tailwind classes
 * instead of raw CSS, HTML compacted (utility classes purged, repeated
 * siblings collapsed), interaction hints + e2e selectors. Raw CSS / full HTML
 * live only in the JSON manifest. Compaction outcomes are surfaced in
 * index.md's "Compaction notes" — never truncated silently.
 */
export const markdownExporter: MigrateExporter = {
  name: "markdown",
  async export(bundle, outDir) {
    const dirNames = bundle.components.map((c, i) => componentDirName(c.role, i + 1));
    const notes: string[] = [];

    bundle.components.forEach((component, i) => {
      const dirName = dirNames[i]!;
      const componentDir = join(outDir, "components", dirName);
      mkdirSync(componentDir, { recursive: true });
      const compact = compactComponentHtml(component.html);
      if (compact.collapsed > 0)
        notes.push(`\`${dirName}\`: collapsed ${compact.collapsed} repeated child element(s)`);
      if (compact.truncated)
        notes.push(`\`${dirName}\`: HTML truncated to fit the per-component token ceiling`);
      writeFileSync(
        join(componentDir, "README.md"),
        renderComponentReadme(bundle.url, component, compact.html),
        "utf8",
      );
    });

    writeFileSync(join(outDir, "index.md"), renderIndex(bundle, notes), "utf8");
  },
};

function renderIndex(bundle: MigrationBundle, notes: string[]): string {
  const lines: string[] = [];
  const md = lines.push.bind(lines);

  md(`# Migration snapshot: ${bundle.url}`);
  md("");
  md("AI-ready, token-lean snapshot for migrating this storefront. Theme + component");
  md("map below; per-component detail (Tailwind, interactions, e2e selectors) lives in");
  md("each `components/<folder>/README.md`. Full raw HTML/CSS is in `manifest.json`.");
  md("");
  md("## Site");
  md("");
  md(`- **URL**: ${bundle.url}`);
  if (bundle.stack && bundle.stack.frontend !== "unknown") {
    const s = bundle.stack;
    const commerce = s.commerce !== "unknown" && s.commerce !== s.frontend ? ` · commerce \`${s.commerce}\`` : "";
    md(`- **Stack**: \`${s.frontend}${s.htmx ? " + htmx" : ""}\`${commerce}`);
  }
  md(`- **Source platform**: ${bundle.platform}`);
  if (bundle.source && bundle.source.kind !== "live-only")
    md(`- **Source repo**: \`${bundle.source.kind}\`${bundle.source.dir ? ` \`${bundle.source.dir}\`` : ""}`);
  if (bundle.target) md(`- **Target**: ${bundle.target} (see MIGRATION_PROMPT.md)`);
  md(`- **Captured**: ${bundle.timestamp} (${bundle.viewport})`);
  md(`- **Pages**: ${bundle.pages.map((p) => `${p.kind} \`${p.path}\``).join(", ") || "—"}`);
  md("");

  if (bundle.screenshots?.length) {
    md("## Screenshots by viewport");
    md("");
    for (const s of bundle.screenshots) md(`- **${s.viewport}**: ![${s.viewport}](${s.path})`);
    md("");
  }

  renderTheme(md, bundle.theme);
  renderAssets(md, bundle.assets);

  if (bundle.vtex) {
    md("## VTEX IO → FastStore blocks");
    md("");
    md(
      `_${bundle.vtex.blocks.length} block instances · ${bundle.vtex.blocks.filter((x) => x.props).length} carry CMS content (props), ${countContentImages(bundle.vtex.blocks)} content images downloaded to \`assets/content/\` (URLs rewritten in \`blocks.json\`). \`confidence\` (0–1) = mapper certainty; \`custom-component\` = build from captured DOM/CSS._`,
    );
    md("");
    md("| VTEX block | → FastStore | confidence | count |");
    md("|---|---|---|---|");
    for (const m of bundle.vtex.map.slice(0, 40)) {
      md(
        `| \`${m.vtex}\` | ${m.faststore ? `\`${m.faststore}\`` : "_custom-component_"} | ${m.confidence || "—"} | ${m.count} |`,
      );
    }
    md("");
  }

  // Folder index per component (stable across fresh/cache via role+selector).
  const compIndex = new Map<string, number>();
  bundle.components.forEach((c, i) => compIndex.set(`${c.role}::${c.selector}`, i + 1));
  const rowFor = (c: MigrationBundle["components"][number]): string => {
    const keys = [...new Set(c.interactions.map((x) => x.e2eKey).filter((k): k is string => Boolean(k)))];
    const dir = componentDirName(c.role, compIndex.get(`${c.role}::${c.selector}`) ?? 1);
    const roleCell = c.repeated && c.repeated > 1 ? `\`${c.role}\` ×${c.repeated}` : `\`${c.role}\``;
    return `| ${roleCell} | ${keys.length ? keys.map((k) => `\`${k}\``).join(", ") : "—"} | [${dir}](./components/${dir}/README.md) |`;
  };
  const globalComps = bundle.components.filter((c) => c.scope === "global");

  md("## Components — by page");
  md("");
  md(`### Global (${globalComps.length}) — on every page`);
  md("");
  md("| Role | e2e keys | Folder |");
  md("|---|---|---|");
  for (const c of globalComps) md(rowFor(c));
  md("");
  for (const pg of bundle.pages) {
    md(`### Page: ${pg.kind} \`${pg.path}\``);
    md("");
    if (pg.components.length) {
      md("| Role | e2e keys | Folder |");
      md("|---|---|---|");
      for (const c of pg.components) md(rowFor(c));
    } else {
      md("_no page-specific components_");
    }
    md("");
  }

  if (notes.length) {
    md("## Compaction notes");
    md("");
    md("_The lean artifact shrank these components; the full data is in `manifest.json`._");
    md("");
    for (const n of notes) md(`- ${n}`);
    md("");
  }

  return lines.join("\n");
}

function renderTheme(md: (s: string) => void, theme: ThemeBundle): void {
  md("## Theme");
  md("");
  md("| Token | Value |");
  md("|---|---|");
  for (const [token, value] of Object.entries(theme.tokens)) {
    md(`| \`${token}\` | \`${value}\` |`);
  }
  md("");
  md(`- **Fonts**: ${listOrNone(theme.typography.fontFamilies)}`);
  md(`- **Font sizes**: ${listOrNone(theme.typography.sizeScale)}`);
  md(`- **Spacing scale**: ${listOrNone(theme.spacingScale)}`);
  md(`- **Radii**: ${listOrNone(theme.radii)}`);
  md(`- **Breakpoints**: ${listOrNone(theme.breakpoints)}`);
  md(`- **Motion**: durations ${listOrNone(theme.motion.durations)} · easings ${listOrNone(theme.motion.easings)}`);
  md(`- **Shadows**: ${theme.shadows.length}`);
  md("");
}

function renderAssets(md: (s: string) => void, assets: MigrationBundle["assets"]): void {
  md("## Brand assets");
  md("");
  md(`- **Logo**: ${assets.logo ? `\`${assets.logo}\`${assets.logoSource ? ` (from ${assets.logoSource})` : ""}` : "_not found_"}`);
  md(`- **Favicon**: ${assets.favicon ? `\`${assets.favicon}\`` : "_not found_"}`);
  md(`- **Apple touch icon**: ${assets.appleTouchIcon ? `\`${assets.appleTouchIcon}\`` : "—"}`);
  md(`- **OG image**: ${assets.ogImage ? `\`${assets.ogImage}\`` : "—"}`);
  md(`- **Web app manifest**: ${assets.manifest ? assets.manifest : "—"}`);
  md(`- **Web fonts**: ${assets.fontFiles.length}/${assets.fonts.length} downloaded${assets.fontFiles.length ? ` → ${listOrNone(assets.fontFiles)}` : ""}`);
  md("");
  if (assets.icons.length) {
    md(`## Icons (${assets.icons.length})`);
    md("");
    md("_Map these to the target's icon set (e.g. FastStore uses Phosphor `<Icon>`)._");
    md("");
    md("| Kind | Id | Count |");
    md("|---|---|---|");
    for (const icon of assets.icons.slice(0, 60)) {
      md(`| ${icon.kind} | \`${escapePipes(icon.id)}\` | ${icon.count} |`);
    }
    md("");
  }
}

function renderComponentReadme(url: string, c: MigratedComponent, compactHtml: string): string {
  const lines: string[] = [];
  const md = lines.push.bind(lines);

  md(`# Component: \`${c.role}\` (${c.scope})`);
  md("");
  if (c.repeated && c.repeated > 1) {
    md(`> ${c.repeated} structurally-identical instances on the page — one shown here.`);
    md("");
  }
  md(`- **Site**: ${url}`);
  if (c.synthetic) {
    md("- **Origin**: source code only — not captured live; port from the source file.");
  } else {
    md(`- **Selector**: \`${c.selector}\``);
    md(`- **Screenshot**: ![${c.role}](screenshot.png)`);
  }
  md("");

  md("## Tailwind (suggested)");
  md("");
  md(c.tailwind.length ? `\`\`\`\n${c.tailwind.join(" ")}\n\`\`\`` : "_none inferred_");
  md("");

  if (c.interactions.length) {
    md("## Interactions & e2e selectors");
    md("");
    md("| Selector | Kind | Label | e2e key | States |");
    md("|---|---|---|---|---|");
    for (const it of c.interactions) {
      const states = [
        it.hasHoverRule ? "hover" : "",
        it.hasFocusRule ? "focus" : "",
        it.animation ? "anim" : "",
      ]
        .filter(Boolean)
        .join(", ");
      md(
        `| \`${escapePipes(it.selector)}\` | ${it.kind} | ${escapePipes(it.label) || "—"} | ${it.e2eKey ? `\`${it.e2eKey}\`` : "—"} | ${states || "—"} |`,
      );
    }
    md("");
  }

  md("## Assets");
  md("");
  md(`- **Images** (${c.assets.images.length}): ${listOrNone(c.assets.images)}`);
  md(`- **Fonts**: ${listOrNone(c.assets.fonts)}`);
  md("");

  if (c.textContent.length) {
    md("## Notable text");
    md("");
    for (const t of c.textContent.slice(0, 15)) md(`- ${t}`);
    md("");
  }

  md("## HTML (compacted)");
  md("");
  md("```html");
  md(compactHtml);
  md("```");
  md("");

  return lines.join("\n");
}

function listOrNone(items: string[]): string {
  if (items.length === 0) return "_none_";
  return items
    .slice(0, 10)
    .map((i) => `\`${i}\``)
    .join(", ");
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}
