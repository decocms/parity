import { describe, expect, it } from "vitest";
import { groupIssues, normalizeSummary } from "../../src/report/group-issues.ts";
import { makeIssue } from "../helpers/make-run.ts";

describe("normalizeSummary", () => {
  it("strips paths, viewports and numbers so page variants collide", () => {
    const a = normalizeSummary("Status divergente em /granado/aniversario::mobile: prod=200");
    const b = normalizeSummary("Status divergente em /outra/pagina::desktop: prod=404");
    expect(a).toBe(b);
  });

  it("keeps genuinely different messages apart", () => {
    expect(normalizeSummary("title ausente no cand")).not.toBe(
      normalizeSummary("canonical divergente no cand"),
    );
  });
});

describe("groupIssues", () => {
  it("collapses the same root cause across 10 pages into one group", () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      makeIssue({
        id: `meta-seo:/page-${i}::mobile`,
        check: "meta-seo",
        severity: "high",
        page: `/page-${i}::mobile`,
        summary: `description ausente em /page-${i}::mobile`,
      }),
    );
    const groups = groupIssues(issues);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(10);
    expect(groups[0]?.pages).toHaveLength(10);
  });

  it("never merges issues from different checks", () => {
    const groups = groupIssues([
      makeIssue({ id: "a", check: "meta-seo", summary: "campo ausente em /x" }),
      makeIssue({ id: "b", check: "image-health", summary: "campo ausente em /x" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("never merges different severities of the same message", () => {
    const groups = groupIssues([
      makeIssue({ id: "a", severity: "high", summary: "diff em /x" }),
      makeIssue({ id: "b", severity: "medium", summary: "diff em /y" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("sorts by severity rank, then by group size", () => {
    const groups = groupIssues([
      makeIssue({ id: "l1", severity: "low", summary: "low issue" }),
      makeIssue({ id: "c1", severity: "critical", summary: "critical issue" }),
      makeIssue({ id: "m1", severity: "medium", summary: "med A em /a" }),
      makeIssue({ id: "m2", severity: "medium", summary: "med A em /b", page: "/b" }),
      makeIssue({ id: "m3", severity: "medium", summary: "med B única" }),
    ]);
    expect(groups[0]?.severity).toBe("critical");
    expect(groups[1]?.severity).toBe("medium");
    expect(groups[1]?.count).toBe(2);
    expect(groups[groups.length - 1]?.severity).toBe("low");
  });
});
