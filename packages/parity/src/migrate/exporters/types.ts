import type { MigrationBundle } from "../../types/migrate.ts";

/**
 * Same shape as extract's `ExtractExporter`, but over a `MigrationBundle`.
 * Kept separate (not generic over extract's type) so the two bundle shapes
 * evolve independently.
 */
export interface MigrateExporter {
  name: string;
  export(bundle: MigrationBundle, outDir: string): Promise<void>;
}
