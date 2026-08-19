#!/usr/bin/env bun
/**
 * sync-skills.ts — re-pulls vendorized knowledge references from upstream repos.
 *
 * Usage:
 *   bun run scripts/sync-skills.ts          # pull and update
 *   bun run scripts/sync-skills.ts --check  # check for drift (exit 1 if any)
 *
 * Only pulls the compact references that are stored verbatim here.
 * Large files (hydration-fixes, navigation) stay as stubs — pull manually.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface SyncEntry {
  /** Destination path in this repo. */
  dest: string;
  /** GitHub repo (owner/name). */
  repo: string;
  /** File path inside the repo. */
  path: string;
  /** If true, skip when --check finds drift (stubs managed manually). */
  stub?: boolean;
}

const ENTRIES: SyncEntry[] = [
  {
    dest: "skills/knowledge/tanstack/jsx-migration.md",
    repo: "decocms/blocks",
    path: ".agents/skills/deco-to-tanstack-migration/references/jsx-migration.md",
  },
  {
    dest: "skills/knowledge/tanstack/react-hooks-patterns.md",
    repo: "decocms/blocks",
    path: ".agents/skills/deco-to-tanstack-migration/references/react-hooks-patterns.md",
  },
  {
    dest: "skills/knowledge/tanstack/search.md",
    repo: "decocms/blocks",
    path: ".agents/skills/deco-to-tanstack-migration/references/search.md",
  },
  {
    dest: "skills/knowledge/vtex/invoke.md",
    repo: "decocms/blocks",
    path: ".cursor/skills/deco-server-functions-invoke/SKILL.md",
  },
  {
    dest: "skills/knowledge/vtex/fetch-cache.md",
    repo: "decocms/blocks",
    path: ".cursor/skills/deco-vtex-fetch-cache/SKILL.md",
  },
  // Stubs — too large to store verbatim, update manually when needed.
  {
    dest: "skills/knowledge/tanstack/hydration-fixes.md",
    repo: "decocms/blocks",
    path: ".agents/skills/deco-to-tanstack-migration/references/hydration-fixes.md",
    stub: true,
  },
  {
    dest: "skills/knowledge/tanstack/navigation.md",
    repo: "decocms/blocks",
    path: ".agents/skills/deco-to-tanstack-migration/references/navigation.md",
    stub: true,
  },
];

const checkOnly = process.argv.includes("--check");
const root = new URL("..", import.meta.url).pathname;
let drifted = 0;

for (const entry of ENTRIES) {
  if (entry.stub) {
    if (checkOnly) console.log(`  [stub] ${entry.dest} — managed manually`);
    continue;
  }
  const destAbs = join(root, entry.dest);
  let upstream: string;
  try {
    const b64 = execSync(
      `gh api repos/${entry.repo}/contents/${entry.path} --jq '.content'`,
      { encoding: "utf8" },
    ).trim();
    upstream = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    console.warn(`  WARN: could not fetch ${entry.repo}:${entry.path}`);
    continue;
  }

  if (existsSync(destAbs)) {
    const local = readFileSync(destAbs, "utf8");
    if (local === upstream) {
      if (!checkOnly) console.log(`  ok   ${entry.dest}`);
      continue;
    }
    if (checkOnly) {
      console.log(`  DRIFT ${entry.dest}`);
      drifted++;
      continue;
    }
  }

  writeFileSync(destAbs, upstream, "utf8");
  console.log(`  wrote ${entry.dest}`);
}

if (checkOnly && drifted > 0) {
  console.error(`\n${drifted} file(s) drifted. Run without --check to update.`);
  process.exit(1);
}
