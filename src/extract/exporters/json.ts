import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractExporter } from "./types.ts";

/** Writes the full, machine-readable `ExtractBundle` to `manifest.json`. */
export const jsonExporter: ExtractExporter = {
  name: "json",
  async export(bundle, outDir) {
    const path = join(outDir, "manifest.json");
    writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  },
};
