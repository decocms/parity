#!/usr/bin/env bun
/**
 * check-refs.ts — fails when the plugin's prose points at something that isn't there.
 *
 * The plugin IS its cross-references: an agent only knows what a skill tells it to
 * load. A path that doesn't resolve doesn't fail loudly — the agent silently works
 * without the knowledge, or invents it. Two live examples this would have caught:
 * `knowledge/INDEX.md` listed `perf/n-plus-1.md` and `perf/variant-selection.md`
 * for months while neither file existed, and `vtex/invoke.md` linked four
 * sibling sub-documents that were never vendorized.
 *
 * Checks, over skills/ + agents/ + commands/:
 *   1. every `skills/**.md` / `agents/**.md` path mentioned exists
 *   2. every relative `](./x.md)` link resolves next to the file that has it
 *   3. every `packages/parity/src/**.ts` path mentioned exists (check/command rot)
 *   4. every `subagent_type: "x"` has an `agents/x.md`
 *
 * Usage: bun run scripts/check-refs.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const ROOTS = ["skills", "agents", "commands"];

const files: string[] = [];
for (const dir of ROOTS) {
  for (const e of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith(".md")) {
      // `e.parentPath` is absolute; keep paths repo-relative for readable errors.
      files.push(join(e.parentPath ?? join(root, dir), e.name).slice(root.length));
    }
  }
}

const PATTERNS: Array<{ re: RegExp; label: string; resolve?: (m: string, from: string) => string }> = [
  // The lookbehind keeps upstream paths out: the vendorized headers cite
  // `.agents/skills/...` in decocms/blocks, which is not a path in this repo.
  { re: /(?<![\w./-])(?:skills|agents)\/[A-Za-z0-9._/-]+\.md/g, label: "plugin path" },
  { re: /(?<![\w./-])packages\/parity\/src\/[A-Za-z0-9._/-]+\.ts/g, label: "CLI source path" },
  {
    re: /\]\((\.\/[A-Za-z0-9._-]+\.md)\)/g,
    label: "relative link",
    resolve: (m, from) => join(dirname(from), m.replace("](", "").replace(")", "")),
  },
];

const problems: string[] = [];

for (const rel of files) {
  const text = readFileSync(join(root, rel), "utf8");

  for (const { re, label, resolve } of PATTERNS) {
    for (const match of text.match(re) ?? []) {
      const target = resolve ? resolve(match, rel) : match;
      if (!existsSync(join(root, target))) {
        problems.push(`${rel}: ${label} does not exist → ${target}`);
      }
    }
  }

  for (const match of text.match(/subagent_type:\s*"([a-z-]+)"/g) ?? []) {
    const agent = match.split('"')[1];
    if (!existsSync(join(root, "agents", `${agent}.md`)))
      problems.push(`${rel}: subagent_type "${agent}" has no agents/${agent}.md`);
  }
}

const unique = [...new Set(problems)];
if (unique.length) {
  console.error(`${unique.length} broken reference(s):\n`);
  for (const p of unique) console.error(`  ${p}`);
  console.error("\nEither create the target or stop referencing it.");
  process.exit(1);
}
console.log(`refs ok — ${files.length} files, every referenced path resolves`);
