import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../../src/commands/run.ts";
import type { RunOptions } from "../../src/commands/run.ts";

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
