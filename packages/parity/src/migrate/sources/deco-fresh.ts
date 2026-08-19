import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { walkFiles } from "./walk.ts";
import type { Source, SourceComponent, SourceInventory } from "./types.ts";

/**
 * Deco on Fresh/Deno — the classic deco.cx storefront. Markers: a `deno.json`
 * that imports `@deco/deco`, plus the Fresh manifest (`fresh.gen.ts`). Sections
 * are `.tsx` files under `sections/`; islands under `islands/`.
 */
function isDecoFresh(repoDir: string): boolean {
  const denoJson = join(repoDir, "deno.json");
  const denoJsonc = join(repoDir, "deno.jsonc");
  const file = existsSync(denoJson) ? denoJson : existsSync(denoJsonc) ? denoJsonc : null;
  if (!file) return false;
  // fresh.gen.ts is the surest tell; the @deco/deco import guards against a
  // non-deco Fresh app.
  if (!existsSync(join(repoDir, "fresh.gen.ts"))) return false;
  try {
    return readFileSync(file, "utf8").includes("@deco/deco");
  } catch {
    return false;
  }
}

/** header/footer/menu render on every page; everything else is page-scoped. */
const GLOBAL_HINT = /\b(header|footer|navbar|menu|topbar)\b/i;

function inventory(repoDir: string): SourceInventory {
  const components: SourceComponent[] = [];
  const sectionsDir = join(repoDir, "sections");
  if (existsSync(sectionsDir)) {
    for (const rel of walkFiles(sectionsDir, [".tsx"])) {
      // `sections/Header/Menu.tsx` → name "Header/Menu" (deco's section key).
      const key = rel.replace(/\.tsx$/, "");
      components.push({
        name: key,
        file: join("sections", rel),
        role: "section",
        scope: GLOBAL_HINT.test(key) ? "global" : "page",
      });
    }
  }
  const notes: string[] = [
    "Source: Deco on Fresh/Deno (Preact + signals, JSX). Sections are the CMS unit.",
  ];
  if (existsSync(join(repoDir, "islands"))) notes.push("Has islands/ — client-interactive components.");
  if (existsSync(join(repoDir, "loaders"))) notes.push("Has loaders/ — server data functions to port.");
  return { components, notes };
}

export const decoFresh: Source = {
  kind: "deco-fresh",
  label: "Deco (Fresh/Deno)",
  detect: isDecoFresh,
  inventory,
  playbook: `## Source: Deco on Fresh/Deno
Sections live in \`sections/*.tsx\` (Preact + \`@preact/signals\`, JSX). Each is a
CMS block; its exported \`Props\` interface is the schema. Islands in \`islands/\`
are the client-interactive parts; loaders in \`loaders/\` are server data
functions. Porting notes: signals → your target's state model, \`useSection\`/
HTMX partials → the target's navigation, and Deno-only imports (\`$fresh/\`,
\`jsr:\`, \`https://\` URLs) have no place in a Node/Vite target.`,
};
