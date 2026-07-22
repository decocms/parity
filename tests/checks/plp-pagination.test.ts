import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plpPagination } from "../../src/checks/plp-pagination.ts";
import type { FlowCapture, StepCapture } from "../../src/types/schema.ts";
import { makeContext } from "../helpers/make-context.ts";

function plpFlow(side: "prod" | "cand", steps: StepCapture[]): FlowCapture {
  return {
    flow: "plp",
    side,
    viewport: "mobile",
    pages: [],
    steps,
    totalDurationMs: 1000,
  };
}

function detectStep(side: "prod" | "cand", mode: string): StepCapture {
  return {
    step: 1,
    name: "detect-pagination-mode",
    side,
    viewport: "mobile",
    status: "ok",
    durationMs: 10,
    screenshotPath: "",
    detail: { mode },
  };
}

function verifyStep(
  side: "prod" | "cand",
  status: StepCapture["status"],
  mode: string,
): StepCapture {
  return {
    step: 3,
    name: "verify-pagination",
    side,
    viewport: "mobile",
    status,
    durationMs: 10,
    screenshotPath: "",
    detail: { mode },
  };
}

describe("plpPagination — interactive step data", () => {
  it("skips when no PLP URL discoverable and no step data", () => {
    return plpPagination(makeContext()).then((r) => {
      expect(r.status).toBe("skipped");
    });
  });

  it("critical when prod paginates (mode=page-link, verified ok) but cand has no pagination affordance (mode=none)", async () => {
    const prod = [detectStep("prod", "page-link"), verifyStep("prod", "ok", "page-link")];
    const cand = [detectStep("cand", "none"), verifyStep("cand", "skipped", "none")];
    const r = await plpPagination(
      makeContext({
        prodFlows: [plpFlow("prod", prod)],
        candFlows: [plpFlow("cand", cand)],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("critical when prod paginates but cand's verify-pagination step failed", async () => {
    const prod = [detectStep("prod", "load-more"), verifyStep("prod", "ok", "load-more")];
    const cand = [detectStep("cand", "load-more"), verifyStep("cand", "failed", "load-more")];
    const r = await plpPagination(
      makeContext({
        prodFlows: [plpFlow("prod", prod)],
        candFlows: [plpFlow("cand", cand)],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues.some((i) => i.severity === "critical")).toBe(true);
  });

  it("medium + inconclusive when the pagination mode changed but both sides still verify ok", async () => {
    const prod = [detectStep("prod", "page-link"), verifyStep("prod", "ok", "page-link")];
    const cand = [
      detectStep("cand", "infinite-scroll"),
      verifyStep("cand", "ok", "infinite-scroll"),
    ];
    const r = await plpPagination(
      makeContext({
        prodFlows: [plpFlow("prod", prod)],
        candFlows: [plpFlow("cand", cand)],
      }),
    );
    const issue = r.issues.find((i) => i.id.includes("mode-changed"));
    expect(issue?.severity).toBe("medium");
    expect(issue?.inconclusive).toBe(true);
  });

  it("passes (no interactive issues) when both sides paginate the same way successfully", async () => {
    const prod = [detectStep("prod", "load-more"), verifyStep("prod", "ok", "load-more")];
    const cand = [detectStep("cand", "load-more"), verifyStep("cand", "ok", "load-more")];
    const r = await plpPagination(
      makeContext({
        prodFlows: [plpFlow("prod", prod)],
        candFlows: [plpFlow("cand", cand)],
      }),
    );
    expect(r.status).toBe("skipped"); // no URL to fetch, no interactive issues raised
    expect(r.issues.length).toBe(0);
  });
});

describe("plpPagination — fetch-based fallback (no step data)", () => {
  const PLP_URL = "https://example.com/categoria";

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = new URL(url);
        const page = u.searchParams.get("page") ?? "1";
        const products =
          page === "1"
            ? ["/produto-a/p", "/produto-b/p"]
            : page === "2"
              ? ["/produto-c/p", "/produto-d/p"]
              : ["/produto-e/p", "/produto-f/p"];
        const html = products.map((p) => `<a href="${p}">x</a>`).join("");
        return new Response(html, { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function pjFlow(side: "prod" | "cand", url: string): FlowCapture {
    return {
      flow: "purchase-journey",
      side,
      viewport: "mobile",
      pages: [],
      steps: [
        {
          step: 2,
          name: "navigate-plp",
          side,
          viewport: "mobile",
          status: "ok",
          durationMs: 10,
          screenshotPath: "",
          url,
        },
      ],
      totalDurationMs: 1000,
    };
  }

  it("passes when both sides paginate correctly (unchanged behavior, no step data present)", async () => {
    const r = await plpPagination(
      makeContext({
        prodFlows: [pjFlow("prod", PLP_URL)],
        candFlows: [pjFlow("cand", PLP_URL)],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues.length).toBe(0);
  });

  it("flags critical when page=2 shows the same products as page=1 (?page=N ignored)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const html = `<a href="/produto-a/p">x</a><a href="/produto-b/p">x</a>`;
        return new Response(html, { status: 200 });
      }),
    );
    const r = await plpPagination(
      makeContext({
        prodFlows: [pjFlow("prod", PLP_URL)],
        candFlows: [pjFlow("cand", PLP_URL)],
      }),
    );
    expect(r.status).toBe("fail");
    expect(
      r.issues.some((i) => i.severity === "critical" && i.id.includes("page2-identical")),
    ).toBe(true);
  });
});

describe("plpPagination — fetch fallback gated off for load-more/infinite-scroll", () => {
  const PLP_URL = "https://example.com/categoria";

  function plpFlowWithPages(side: "prod" | "cand", steps: StepCapture[]): FlowCapture {
    return {
      flow: "plp",
      side,
      viewport: "mobile",
      pages: [
        {
          url: PLP_URL,
          finalUrl: PLP_URL,
          status: 200,
          viewport: "mobile",
          side,
          durationMs: 10,
          html: "",
          vitals: { lcp: null, cls: null, fcp: null, ttfb: null, inp: null },
          console: [],
          network: [],
          screenshotPath: "",
        },
      ],
      steps,
      totalDurationMs: 1000,
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not call fetch for a side whose interactive mode is load-more", async () => {
    const fetchSpy = vi.fn(async () => new Response("<html></html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const prod = [detectStep("prod", "load-more"), verifyStep("prod", "ok", "load-more")];
    const cand = [detectStep("cand", "load-more"), verifyStep("cand", "ok", "load-more")];
    await plpPagination(
      makeContext({
        prodFlows: [plpFlowWithPages("prod", prod)],
        candFlows: [plpFlowWithPages("cand", cand)],
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
