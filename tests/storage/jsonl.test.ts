import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlWriter, checkToJsonl } from "../../src/storage/jsonl.ts";
import type { CheckResult } from "../../src/types/schema.ts";

describe("JsonlWriter (issue #53: stream check results to agents)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parity-jsonl-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("escreve metadata + 2 checks + final em ordem", () => {
    const file = join(dir, "out.jsonl");
    const w = new JsonlWriter(file);

    w.write({
      type: "metadata",
      schemaVersion: "1.0",
      runId: "r1",
      prodUrl: "https://prod.example.com",
      candUrl: "https://cand.example.com",
      flows: ["homepage"],
      viewports: ["mobile"],
      timestamp: "2026-06-16T00:00:00Z",
    });
    w.write({
      type: "check",
      runId: "r1",
      check: "console-errors-baseline",
      status: "pass",
      severity: "critical",
      durationMs: 12,
      summary: "no new console errors",
      issueCount: 0,
      issues: [],
    });
    w.write({
      type: "check",
      runId: "r1",
      check: "visual-regression",
      status: "warn",
      severity: "medium",
      durationMs: 234,
      summary: "1 page with diff",
      issueCount: 1,
      issues: [
        {
          id: "vd:home:mobile",
          severity: "medium",
          category: "visual",
          summary: "diff > 5%",
          page: "/",
          check: "visual-regression",
        },
      ],
    });
    w.write({
      type: "complete",
      runId: "r1",
      totalDurationMs: 5000,
      totalChecks: 2,
      totalIssues: 1,
      verdict: { status: "warn", score: 88 },
    });
    w.close();

    const raw = readFileSync(file, "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(4);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ type: "metadata", schemaVersion: "1.0", runId: "r1" });
    expect(parsed[1]).toMatchObject({ type: "check", check: "console-errors-baseline" });
    expect(parsed[2]).toMatchObject({ type: "check", issueCount: 1 });
    expect(parsed[3]).toMatchObject({ type: "complete", totalChecks: 2 });
  });

  it("cada linha termina com newline (JSONL spec)", () => {
    const file = join(dir, "newlines.jsonl");
    const w = new JsonlWriter(file);
    w.write({
      type: "metadata",
      schemaVersion: "1.0",
      runId: "r1",
      prodUrl: "p",
      candUrl: "c",
      flows: [],
      viewports: [],
      timestamp: "t",
    });
    w.close();
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });

  it("emite type:'error' como terminal record alternativo a complete", () => {
    const file = join(dir, "error.jsonl");
    const w = new JsonlWriter(file);
    w.write({
      type: "error",
      runId: "r1",
      message: "boom",
      durationMs: 1234,
    });
    w.close();
    const parsed = JSON.parse(readFileSync(file, "utf8").trim());
    expect(parsed).toMatchObject({ type: "error", message: "boom" });
  });

  it("close() é idempotente", () => {
    const file = join(dir, "close.jsonl");
    const w = new JsonlWriter(file);
    expect(() => {
      w.close();
      w.close();
    }).not.toThrow();
  });

  it("stdout target ('-') escreve em process.stdout", () => {
    const writes: string[] = [];
    const stdoutAny = process.stdout as unknown as { write: (chunk: unknown) => boolean };
    const orig = stdoutAny.write.bind(process.stdout);
    stdoutAny.write = (chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const w = new JsonlWriter("-");
      w.write({
        type: "complete",
        runId: "r1",
        totalDurationMs: 1,
        totalChecks: 0,
        totalIssues: 0,
        verdict: { status: "pass", score: 100 },
      });
      w.close();
    } finally {
      stdoutAny.write = orig;
    }
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^\{.*\}\n$/);
    expect(JSON.parse(writes[0]!.trim())).toMatchObject({ type: "complete" });
  });
});

describe("checkToJsonl", () => {
  it("projeta CheckResult em JsonlCheckRecord", () => {
    const c: CheckResult = {
      name: "my-check",
      status: "fail",
      severity: "high",
      durationMs: 99,
      summary: "boom",
      issues: [
        {
          id: "x:1",
          severity: "high",
          category: "console",
          summary: "uncaught error",
          page: "/foo",
          check: "my-check",
          details: "stack trace…",
        },
      ],
    };
    const out = checkToJsonl("run-42", c);
    expect(out.type).toBe("check");
    expect(out.runId).toBe("run-42");
    expect(out.check).toBe("my-check");
    expect(out.durationMs).toBe(99);
    expect(out.issues).toHaveLength(1);
    // `details` deve ser omitido (JSONL line stays compact)
    expect((out.issues[0] as Record<string, unknown>).details).toBeUndefined();
  });
});
