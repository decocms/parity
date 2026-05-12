import type { Issue, Run } from "../../src/types/schema.ts";

export function makeIssue(over: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    severity: "medium",
    category: "functional",
    check: "demo",
    summary: "demo issue",
    ...over,
  };
}

export function makeRun(over: Partial<Run> = {}): Run {
  return {
    schemaVersion: "0.1",
    id: "run-test",
    timestamp: "2026-01-01T00:00:00Z",
    prodUrl: "https://prod.example.com",
    candUrl: "https://cand.example.com",
    flows: ["homepage"],
    viewports: ["mobile"],
    cep: "01310-100",
    durationMs: 12_345,
    verdict: {
      status: "warn",
      score: 70,
      critical: 0,
      high: 1,
      medium: 1,
      low: 0,
      checksRun: 3,
      checksPassed: 1,
      checksFailed: 1,
      checksSkipped: 1,
    },
    topIssues: [],
    issues: [],
    checks: [],
    flowCaptures: [],
    ...over,
  };
}
