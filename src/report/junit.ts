import type { Run } from "../types/schema.ts";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderJUnit(run: Run): string {
  const tests = run.checks.length;
  const failures = run.checks.filter((c) => c.status === "fail").length;
  const warns = run.checks.filter((c) => c.status === "warn").length;
  const skipped = run.checks.filter((c) => c.status === "skipped").length;

  const testcases = run.checks
    .map((c) => {
      const inner: string[] = [];
      if (c.status === "fail") {
        inner.push(`<failure type="${esc(c.name)}" message="${esc(c.summary)}"/>`);
      } else if (c.status === "warn") {
        inner.push(`<system-out>WARN: ${esc(c.summary)}</system-out>`);
      } else if (c.status === "skipped") {
        inner.push(`<skipped message="${esc(c.summary)}"/>`);
      }
      return `<testcase classname="parity" name="${esc(c.name)}" time="${(c.durationMs / 1000).toFixed(3)}">${inner.join("")}</testcase>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="parity" tests="${tests}" failures="${failures + warns}" skipped="${skipped}" time="${(run.durationMs / 1000).toFixed(3)}">
${testcases}
</testsuite>`;
}
