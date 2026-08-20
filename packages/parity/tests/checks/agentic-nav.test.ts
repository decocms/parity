import { describe, expect, it } from "vitest";
import { agenticNav, assessLlmsTxt } from "../../src/checks/agentic-nav.ts";
import type { AgentA11yAudit } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";
import { mockFetch } from "../helpers/mock-fetch.ts";

describe("assessLlmsTxt", () => {
  it("accepts a well-formed llms.txt (H1 + links)", () => {
    const r = assessLlmsTxt(
      "# Portal\n\n> Resumo do site\n\n## Páginas\n- [Home](https://x.com/)\n",
    );
    expect(r).toMatchObject({ present: true, wellFormed: true });
  });

  it("rejects when the H1 title is missing", () => {
    const r = assessLlmsTxt("Portal\n- [Home](https://x.com/)\n");
    expect(r.wellFormed).toBe(false);
    expect(r.reason).toMatch(/H1/);
  });

  it("rejects when there are no sections or links", () => {
    const r = assessLlmsTxt("# Portal\n\nsó um parágrafo solto\n");
    expect(r.wellFormed).toBe(false);
    expect(r.reason).toMatch(/seções|links/);
  });

  it("rejects empty", () => {
    expect(assessLlmsTxt("   ").wellFormed).toBe(false);
  });
});

const failAudit: AgentA11yAudit = {
  id: "button-name",
  title: "Buttons do not have an accessible name",
  score: 0,
  elements: [{ selector: "button.flex", snippet: "<button>" }],
};

describe("agenticNav", () => {
  it("fails when agent-a11y audits fail and llms.txt is missing", async () => {
    const { restore } = mockFetch({}); // /llms.txt → 404
    const r = await agenticNav(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod" })],
        candPages: [
          makePageCapture({ url: "https://x.com/", side: "cand", agentA11y: [failAudit] }),
        ],
      }),
    );
    restore();
    expect(r.status).toBe("fail");
    expect(r.issues.find((i) => i.id === "agentic:a11y-tree")).toBeDefined();
    expect(r.issues.find((i) => i.id === "agentic:llms-txt")).toBeDefined();
    const data = r.data as { agentic: { passed: number; total: number } };
    expect(data.agentic).toMatchObject({ passed: 0, total: 2 });
  });

  it("passes both pillars when a11y is clean and llms.txt is well-formed", async () => {
    const { restore } = mockFetch({
      "/llms.txt": {
        status: 200,
        body: "# Portal\n\n## Páginas\n- [Home](https://x.com/)\n",
        headers: { "content-type": "text/plain" },
      },
    });
    const r = await agenticNav(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod" })],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            agentA11y: [{ ...failAudit, score: 1 }],
          }),
        ],
      }),
    );
    restore();
    expect(r.status).toBe("pass");
    const data = r.data as { agentic: { passed: number; total: number } };
    expect(data.agentic).toMatchObject({ passed: 2, total: 2 });
  });
});
