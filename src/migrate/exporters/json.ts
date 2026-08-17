import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MigrateExporter } from "./types.ts";

/**
 * Full-tier manifest — the complete `MigrationBundle` (raw HTML + full
 * computed styles + assets). Fallback/debug source of truth; NOT meant to be
 * fed to an LLM (see the lean markdown exporter for that).
 */
export const jsonExporter: MigrateExporter = {
  name: "json",
  async export(bundle, outDir) {
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  },
};
