import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a unique temporary directory. The caller is responsible for calling
 * `cleanup()` (typically inside `afterEach`).
 */
export function makeTmpDir(prefix = "parity-test-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* tolerated — best-effort cleanup */
      }
    },
  };
}
