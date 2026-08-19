import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractedComponent } from "../../types/extract.ts";
import { componentDirName } from "../naming.ts";
import type { ExtractExporter } from "./types.ts";

/**
 * Markdown exporter — the artifact meant to be pasted into an AI
 * migration agent's context. Mirrors the tone/structure conventions
 * `report/prompt-builder.ts` and `diff/section-bundle.ts` already
 * established (heading + bullet metadata block, a table for
 * structured deltas, embedded image refs, terse "what this is for"
 * framing) rather than inventing a new style.
 *
 * Writes:
 *  - `index.md` — site-level overview + links to each component README.
 *  - `components/<role>-<index>/README.md` — one per component.
 */
export const markdownExporter: ExtractExporter = {
  name: "markdown",
  async export(bundle, outDir) {
    const dirNames = bundle.components.map((c, i) => componentDirName(c.role, i + 1));

    const indexMd = renderIndex(bundle, dirNames);
    writeFileSync(join(outDir, "index.md"), indexMd, "utf8");

    bundle.components.forEach((component, i) => {
      const dirName = dirNames[i]!;
      const componentDir = join(outDir, "components", dirName);
      mkdirSync(componentDir, { recursive: true });
      const readme = renderComponentReadme(bundle, component);
      writeFileSync(join(componentDir, "README.md"), readme, "utf8");
    });
  },
};

function renderIndex(
  bundle: { url: string; timestamp: string; viewport: string; components: ExtractedComponent[] },
  dirNames: string[],
): string {
  const lines: string[] = [];
  const md = lines.push.bind(lines);

  md(`# UI component extract: ${bundle.url}`);
  md("");
  md("This is an AI-ready snapshot of this site's UI components — captured for a from-scratch");
  md("migration where there is no source code to read. Each component below has its own");
  md("folder with the rendered HTML, computed styles, a cropped screenshot, and asset/link");
  md("inventories. Paste the relevant component READMEs into your migration agent's context.");
  md("");
  md("## Site");
  md("");
  md(`- **URL**: ${bundle.url}`);
  md(`- **Captured**: ${bundle.timestamp}`);
  md(`- **Viewport**: ${bundle.viewport}`);
  md(`- **Components detected**: ${bundle.components.length}`);
  md("");
  md("## Components");
  md("");
  md("| Role | Selector | Folder |");
  md("|---|---|---|");
  bundle.components.forEach((c, i) => {
    const dirName = dirNames[i];
    md(
      `| \`${c.role}\` | \`${escapePipes(c.selector)}\` | [${dirName}](./components/${dirName}/README.md) |`,
    );
  });
  md("");
  return lines.join("\n");
}

function renderComponentReadme(bundle: { url: string }, component: ExtractedComponent): string {
  const lines: string[] = [];
  const md = lines.push.bind(lines);

  md(`# Component: \`${component.role}\``);
  md("");
  md(`- **Site**: ${bundle.url}`);
  md(`- **Selector**: \`${component.selector}\``);
  md(`- **Screenshot**: ![${component.role}](../../${relativeScreenshot(component)})`);
  md("");

  md("## Design tokens (computed styles)");
  md("");
  if (component.computedStyles && Object.keys(component.computedStyles).length > 0) {
    md("| Property | Value |");
    md("|---|---|");
    for (const [key, value] of Object.entries(component.computedStyles)) {
      if (!value) continue;
      md(`| \`${key}\` | \`${value}\` |`);
    }
  } else {
    md("_No computed styles captured for this component._");
  }
  md("");

  md("## Assets");
  md("");
  md(`- **Images** (${component.assets.images.length}): ${listOrNone(component.assets.images)}`);
  md(
    `- **Background images** (${component.assets.backgroundImages.length}): ${listOrNone(component.assets.backgroundImages)}`,
  );
  md(`- **Fonts**: ${listOrNone(component.assets.fonts)}`);
  md("");

  if (component.links.length > 0) {
    md("## Links");
    md("");
    for (const link of component.links) {
      const text = link.text || "_(no text)_";
      md(`- [${text}](${link.href})`);
    }
    md("");
  }

  if (component.textContent.length > 0) {
    md("## Notable text");
    md("");
    for (const t of component.textContent.slice(0, 20)) {
      md(`- ${t}`);
    }
    md("");
  }

  md("## HTML");
  md("");
  md("```html");
  md(truncateHtml(component.html, 4_000));
  md("```");
  md("");

  return lines.join("\n");
}

function relativeScreenshot(component: ExtractedComponent): string {
  // screenshotPath is written as `<componentDir>/screenshot.png`; the
  // README lives one level deeper (`components/<dir>/README.md`), so a
  // same-directory relative reference is enough. Callers that move the
  // bundle keep this working as long as the relative layout is preserved.
  return "screenshot.png";
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

function truncateHtml(html: string, max: number): string {
  if (html.length <= max) return html;
  return `${html.slice(0, max)}\n<!-- TRUNCATED -->`;
}
