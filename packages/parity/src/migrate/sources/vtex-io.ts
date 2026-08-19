import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { walkFiles } from "./walk.ts";
import type { Source, SourceComponent, SourceInventory } from "./types.ts";

/**
 * VTEX IO Store Framework. Marker: a `manifest.json` with a `vendor` field and a
 * `store` builder / `vtex.store*` dep. Content is declarative — block trees in
 * `store/blocks/**\/*.{json,jsonc}`, each top-level key a block id like
 * `store.home` or `flex-layout.row#deals`.
 */
function readManifest(repoDir: string): Record<string, unknown> | null {
  const file = join(repoDir, "manifest.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isVtexIo(repoDir: string): boolean {
  const m = readManifest(repoDir);
  if (!m || typeof m.vendor !== "string") return false;
  const builders = (m.builders ?? {}) as Record<string, unknown>;
  const deps = (m.dependencies ?? {}) as Record<string, unknown>;
  return "store" in builders || Object.keys(deps).some((d) => d.startsWith("vtex.store"));
}

/**
 * Strip `//` and `/* *\/` comments so a `.jsonc` block file parses. Not a full
 * JSONC parser — it does not touch comment-like sequences inside strings — but
 * block files are machine-shaped config where that case doesn't occur, and a
 * parse failure just skips that file rather than crashing the scan.
 */
function stripJsonc(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Block id before the `#instance` suffix — `flex-layout.row#deals` → `flex-layout.row`. */
function blockName(id: string): string {
  return id.split("#")[0] ?? id;
}

const GLOBAL_HINT = /header|footer|menu|minicart|navbar/i;

function inventory(repoDir: string): SourceInventory {
  const blocksDir = join(repoDir, "store", "blocks");
  const seen = new Map<string, SourceComponent>();
  if (existsSync(blocksDir)) {
    for (const rel of walkFiles(blocksDir, [".json", ".jsonc"])) {
      const abs = join(blocksDir, rel);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(stripJsonc(readFileSync(abs, "utf8")));
      } catch {
        continue;
      }
      for (const id of Object.keys(parsed)) {
        const name = blockName(id);
        // Dedupe by block name — the same block is referenced across many
        // files; the first definition file is the useful one.
        if (seen.has(name)) continue;
        seen.set(name, {
          name,
          file: join("store", "blocks", rel),
          role: "section",
          scope: GLOBAL_HINT.test(name) ? "global" : "page",
        });
      }
    }
  }
  const m = readManifest(repoDir);
  const deps = m ? Object.keys((m.dependencies ?? {}) as Record<string, unknown>) : [];
  const notes = [
    "Source: VTEX IO Store Framework (declarative block trees, not React source).",
    deps.length ? `Depends on ${deps.length} VTEX apps (e.g. ${deps.slice(0, 4).join(", ")}).` : "",
    "Block PROPS are the merchant's CMS content; block STRUCTURE is the app-provided component.",
  ].filter(Boolean);
  return { components: [...seen.values()], notes };
}

export const vtexIo: Source = {
  kind: "vtex-io",
  label: "VTEX IO (Store Framework)",
  detect: isVtexIo,
  inventory,
  playbook: `## Source: VTEX IO (Store Framework)
The storefront is DECLARATIVE: \`store/blocks/**/*.{json,jsonc}\` define block
trees keyed by block id (\`store.home\`, \`flex-layout.row#deals\`). A block's
\`props\` is the merchant's CMS content; its structure/behavior comes from a
VTEX app (\`vtex.store-components\`, \`vtex.product-summary\`, …) — there is no
per-block React source in this repo to copy. Rebuild each app-provided block as
a native component on the target, and carry the props across as CMS content. The
live \`parity migrate\` capture (\`window.__RUNTIME__\`) resolves the SAME block
tree with real content, so use it to fill in props the static files leave as
CMS placeholders.`,
};
