/**
 * Shared `<role>-<index>` directory-naming convention for `parity extract`
 * output — used by both the command orchestrator (to decide where
 * `extractComponent` writes component.html/styles.json/screenshot.png)
 * and the markdown exporter (to link to the same directory from
 * `index.md`). Kept in one place so the two never drift.
 */
export function componentDirName(role: string, index: number): string {
  const slug =
    role
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "component";
  return `${slug}-${index}`;
}
