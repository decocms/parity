import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateFailOnGate, runCommand } from "../../src/commands/run.ts";
import type { RunOptions } from "../../src/commands/run.ts";
import type { Issue } from "../../src/types/schema.ts";

/**
 * Issue #141: `parity run` compares two URLs. When `--prod` is omitted the
 * command must exit early (code 2) with a hint pointing at `parity e2e`,
 * instead of forcing a degenerate `--prod X --cand X` self-comparison or
 * launching a browser.
 */
describe("runCommand single-site guard (#141)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("returns exit code 2 and points to `parity e2e` when --prod is missing", async () => {
    const opts = { cand: "http://localhost:5173/" } as RunOptions;
    const code = await runCommand(opts);
    expect(code).toBe(2);
    const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toMatch(/parity e2e --url http:\/\/localhost:5173\//);
  });

  it("uses a <url> placeholder when neither --prod nor --cand is given", async () => {
    const code = await runCommand({} as RunOptions);
    expect(code).toBe(2);
    const printed = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toMatch(/parity e2e --url <url>/);
  });
});

/**
 * Issue #178 (problem #1): the blocking-issue exit-1 check used to be gated
 * behind `--ci`, which had no other effect anywhere in the codebase — a run
 * with a blocking-severity issue silently exited 0 unless the caller also
 * passed `--ci`. `evaluateFailOnGate` is the extracted, unconditional
 * decision the full `runCommand` pipeline now always applies after a run
 * completes, regardless of `--ci`.
 */
describe("evaluateFailOnGate (#178)", () => {
  it("returns exit code 1 when a blocking-severity issue is present, without needing --ci", () => {
    const issues = [{ severity: "critical" }, { severity: "low" }] as Issue[];
    const result = evaluateFailOnGate(issues, ["critical"]);
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/1 issue\(s\) bloqueante\(s\)/);
  });

  it("returns exit code 0 when no issue matches --fail-on severities", () => {
    const issues = [{ severity: "low" }, { severity: "medium" }] as Issue[];
    const result = evaluateFailOnGate(issues, ["critical"]);
    expect(result.exitCode).toBe(0);
    expect(result.message).toBeUndefined();
  });
});
