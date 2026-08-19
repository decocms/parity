import type { ExtractBundle } from "../../types/extract.ts";

export type { ExtractBundle };

export interface ExtractExporter {
  name: string;
  export(bundle: ExtractBundle, outDir: string): Promise<void>;
}
