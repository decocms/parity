import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { aggregateIssues } from "../../src/llm/aggregate-issues.ts";
import type { CheckResult, Issue } from "../../src/types/schema.ts";
import { makeIssue } from "../helpers/make-run.ts";

function makeCheck(over: Partial<CheckResult> = {}): CheckResult {
  return {
    name: "demo",
    status: "fail",
    severity: "high",
    durationMs: 100,
    summary: "demo",
    issues: [],
    ...over,
  };
}

describe("aggregateIssues — fallback path (no LLM)", () => {
  const ORIG = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
  afterEach(() => {
    if (ORIG) process.env.ANTHROPIC_API_KEY = ORIG;
  });

  it("returns deterministic issues sorted by severity", async () => {
    const out = await aggregateIssues({
      runId: "x",
      prodUrl: "p",
      candUrl: "c",
      viewports: ["mobile"],
      flows: ["homepage"],
      checks: [
        makeCheck({
          issues: [
            makeIssue({ id: "a", severity: "low" }),
            makeIssue({ id: "b", severity: "critical" }),
            makeIssue({ id: "c", severity: "high" }),
          ],
        }),
      ],
    });
    expect(out.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("dedupes by issue id", async () => {
    const out = await aggregateIssues({
      runId: "x",
      prodUrl: "p",
      candUrl: "c",
      viewports: [],
      flows: [],
      checks: [
        makeCheck({ issues: [makeIssue({ id: "dup" })] }),
        makeCheck({ issues: [makeIssue({ id: "dup" })] }),
      ],
    });
    expect(out).toHaveLength(1);
  });

  it("caps at 10 issues", async () => {
    const many: Issue[] = Array.from({ length: 30 }, (_, i) =>
      makeIssue({ id: `i-${i}`, severity: "medium" }),
    );
    const out = await aggregateIssues({
      runId: "x",
      prodUrl: "p",
      candUrl: "c",
      viewports: [],
      flows: [],
      checks: [makeCheck({ issues: many })],
    });
    expect(out).toHaveLength(10);
  });
});

describe("aggregateIssues — LLM path", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    mockCreate.mockReset();
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("returns empty array when no failed/warn checks", async () => {
    const out = await aggregateIssues({
      runId: "x",
      prodUrl: "p",
      candUrl: "c",
      viewports: [],
      flows: [],
      checks: [makeCheck({ status: "pass" })],
    });
    expect(out).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("uses LLM tool output when available", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_issues",
          input: {
            issues: [
              {
                id: "agg-1",
                severity: "high",
                category: "seo",
                check: "meta-seo-parity",
                summary: "agg from LLM",
              },
            ],
          },
        },
      ],
    });
    const out = await aggregateIssues({
      runId: "x",
      prodUrl: "p",
      candUrl: "c",
      viewports: [],
      flows: [],
      checks: [makeCheck({ issues: [makeIssue()] })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("agg-1");
    expect(out[0]?.summary).toBe("agg from LLM");
  });

  it("falls back to deterministic when LLM returns null/no tool block", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "no tool" }] });
    const out = await aggregateIssues({
      runId: "x",
      prodUrl: "p",
      candUrl: "c",
      viewports: [],
      flows: [],
      checks: [makeCheck({ issues: [makeIssue({ id: "fallback" })] })],
    });
    expect(out[0]?.id).toBe("fallback");
  });

  it("filters out LLM responses missing required fields", async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: "tool_use",
          name: "report_issues",
          input: {
            issues: [
              { id: "ok", severity: "high", category: "seo", check: "x", summary: "ok" },
              { id: "bad" /* missing severity */ },
              { severity: "low" /* missing id */ },
            ],
          },
        },
      ],
    });
    const out = await aggregateIssues({
      runId: "x",
      prodUrl: "p",
      candUrl: "c",
      viewports: [],
      flows: [],
      checks: [makeCheck({ issues: [makeIssue()] })],
    });
    expect(out.map((i) => i.id)).toEqual(["ok"]);
  });
});
