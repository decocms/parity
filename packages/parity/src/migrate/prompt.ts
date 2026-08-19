/**
 * Builds MIGRATION_PROMPT.md — the target-agnostic instruction the agent
 * reads first. Points at the theme + per-component READMEs (it does NOT
 * inline them — token economy) and appends the target playbook when
 * `--target` was passed. Mirrors the terse framing of report/prompt-builder.ts.
 */

import { componentDirName } from "../extract/naming.ts";
import type { MigrationBundle } from "../types/migrate.ts";

export function buildMigrationPrompt(
  bundle: MigrationBundle,
  playbook?: string,
  source?: { playbook?: string; notes?: string[] },
): string {
  const lines: string[] = [];
  const md = lines.push.bind(lines);

  md(`# Migration prompt: ${bundle.url}`);
  md("");
  md("You are migrating this storefront to a new framework. This folder is an");
  md("AI-ready snapshot of the live site — theme, page structure, and per-component");
  md("detail (suggested Tailwind classes, interaction hints, e2e selectors).");
  md("");
  md(`- **Source platform**: ${bundle.platform}`);
  md(`- **Captured**: ${bundle.timestamp} (${bundle.viewport})`);
  md(`- **Pages**: ${bundle.pages.map((p) => `${p.kind} (${p.path})`).join(", ") || "—"}`);
  md("");

  // Source-side context: what the FROM stack is + gotchas the scan surfaced.
  // Prepended before the target playbook so the agent frames the port correctly.
  if (source?.playbook) {
    md(source.playbook);
    md("");
  }
  if (source?.notes?.length) {
    md("**Source scan notes:**");
    md("");
    for (const n of source.notes) md(`- ${n}`);
    md("");
  }

  md("## How to work");
  md("");
  md("1. Read `index.md` for the theme tokens and the component map.");
  md("2. Start with **global** components (header/footer/minicart) — they appear on");
  md("   every page — then do page components per page kind (home → PLP → PDP).");
  md("3. For each component, open its `components/<folder>/README.md`: use the");
  md("   suggested Tailwind classes as the styling source of truth, keep the raw HTML");
  md("   only as a structure reference, and wire the listed e2e selectors.");
  md("4. Apply the theme tokens once, globally, then reference them (`bg-primary`).");
  md("");

  const globals = bundle.components.filter((c) => c.scope === "global");
  const pageComps = bundle.components.filter((c) => c.scope === "page");
  const row = (c: MigrationBundle["components"][number], i: number) =>
    `- \`${c.role}\` → components/${componentDirName(c.role, i + 1)}/README.md${
      c.synthetic ? " _(source-only — no live capture; port from source code)_" : ""
    }`;
  if (globals.length) {
    md("### Global components");
    bundle.components.forEach((c, i) => c.scope === "global" && md(row(c, i)));
    md("");
  }
  if (pageComps.length) {
    md("### Page components");
    bundle.components.forEach((c, i) => c.scope === "page" && md(row(c, i)));
    md("");
  }

  if (playbook) {
    md("---");
    md("");
    md(playbook);
    md("");
  }

  return lines.join("\n");
}
