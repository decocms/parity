import { describe, expect, it } from "vitest";
import { escapeHtml, humanKey, relPath, renderIssueHtml } from "../../src/report/issue-html.ts";
import type { Issue } from "../../src/types/schema.ts";

describe("escapeHtml", () => {
  it("escapa caracteres HTML perigosos", () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });
  it("preserva texto comum", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
  it("trata null/undefined como vazio", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
  it("converte número pra string", () => {
    expect(escapeHtml(42)).toBe("42");
  });
});

describe("humanKey", () => {
  it("/::mobile → Home · mobile", () => {
    expect(humanKey("/::mobile")).toBe("Home · mobile");
  });
  it("/c/sale::desktop → /c/sale · desktop", () => {
    expect(humanKey("/c/sale::desktop")).toBe("/c/sale · desktop");
  });
  it("key sem viewport mantém só o path", () => {
    expect(humanKey("/x")).toBe("/x");
  });
  it("string vazia retorna 'Home'", () => {
    expect(humanKey("::mobile")).toBe("Home · mobile");
  });
});

describe("relPath", () => {
  it("retorna vazio quando absPath é undefined", () => {
    expect(relPath("/foo", undefined)).toBe("");
  });
  it("calcula path relativo", () => {
    expect(relPath("/foo/bar", "/foo/bar/baz.png")).toBe("baz.png");
  });
});

describe("renderIssueHtml", () => {
  const baseIssue: Issue = {
    id: "test:1",
    severity: "high",
    category: "performance",
    check: "test-check",
    summary: "Test summary",
  };

  it("renderiza tags básicas + summary", () => {
    const html = renderIssueHtml(baseIssue);
    expect(html).toContain('class="issue sev-high"');
    expect(html).toContain('class="tag sev-high"');
    expect(html).toContain("test-check");
    expect(html).toContain("<h3>Test summary</h3>");
  });

  it("escapa o summary contra XSS", () => {
    const html = renderIssueHtml({ ...baseIssue, summary: "<img onerror=x>" });
    expect(html).toContain("&lt;img onerror=x&gt;");
    expect(html).not.toContain("<img onerror=x>");
  });

  it("inclui tag de página quando issue.page está presente", () => {
    const html = renderIssueHtml({ ...baseIssue, page: "/::mobile" });
    expect(html).toContain('class="tag tag-page"');
    expect(html).toContain("Home · mobile");
  });

  it("omite tag de página quando issue.page é undefined", () => {
    const html = renderIssueHtml(baseIssue);
    expect(html).not.toContain("tag-page");
  });

  it("includes details in <details> when issue.details is set", () => {
    const html = renderIssueHtml({ ...baseIssue, details: "line 1\nline 2" });
    expect(html).toContain('<details class="issue-section"');
    expect(html).toContain("Details");
    expect(html).toContain("line 1");
  });

  it("inclui screenshots somente quando runDir é passado E há evidence", () => {
    const issueWithEvidence: Issue = {
      ...baseIssue,
      evidence: [{ kind: "screenshot", path: "/tmp/run/shot.png", label: "prod" }],
    };
    // Without runDir: skip
    const without = renderIssueHtml(issueWithEvidence);
    expect(without).not.toContain("<figure>");
    // With runDir: include
    const withRun = renderIssueHtml(issueWithEvidence, { runDir: "/tmp/run" });
    expect(withRun).toContain("<figure>");
    expect(withRun).toContain("shot.png");
  });

  it("includes 'Suggested fix' section when issue.suggestedFix is present", () => {
    const html = renderIssueHtml({ ...baseIssue, suggestedFix: "Add the missing tag." });
    expect(html).toContain("Suggested fix");
    expect(html).toContain("Add the missing tag.");
  });

  it("includes 'Reproduction' section when issue.reproduction is present", () => {
    const html = renderIssueHtml({ ...baseIssue, reproduction: "Step 1: do X\nStep 2: do Y" });
    expect(html).toContain("Reproduction");
    expect(html).toContain("Step 1");
  });
});
