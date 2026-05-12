import { describe, expect, it } from "vitest";
import { httpStatusParity } from "../../src/checks/http-status.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

describe("httpStatusParity", () => {
  it("passes when both sides return matching 2xx", () => {
    const r = httpStatusParity(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", status: 200, side: "prod" })],
        candPages: [makePageCapture({ url: "https://x.com/", status: 200, side: "cand" })],
      }),
    );
    expect(r.status).toBe("pass");
    expect(r.issues).toEqual([]);
  });

  it("fails as critical when statuses diverge (200 vs 404)", () => {
    const r = httpStatusParity(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", status: 200, side: "prod" })],
        candPages: [makePageCapture({ url: "https://x.com/", status: 404, side: "cand" })],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues[0]?.severity).toBe("critical");
    expect(r.issues[0]?.summary).toMatch(/prod=200/);
    expect(r.issues[0]?.summary).toMatch(/cand=404/);
  });

  it("flags pages only in prod as high (regression risk)", () => {
    const r = httpStatusParity(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/orphan", side: "prod" })],
        candPages: [],
      }),
    );
    expect(r.status).toBe("warn");
    const orphan = r.issues.find((i) => i.id.includes("missing-cand"));
    expect(orphan?.severity).toBe("high");
  });

  it("flags pages only in cand as low (extra coverage, not a regression)", () => {
    const r = httpStatusParity(
      makeContext({
        prodPages: [],
        candPages: [makePageCapture({ url: "https://x.com/new", side: "cand" })],
      }),
    );
    const newPage = r.issues.find((i) => i.id.includes("missing-prod"));
    expect(newPage?.severity).toBe("low");
  });

  it("pairs by pathname + viewport (different hosts allowed)", () => {
    const r = httpStatusParity(
      makeContext({
        prodPages: [makePageCapture({ url: "https://prod.example/", side: "prod", status: 200 })],
        candPages: [makePageCapture({ url: "https://cand.example/", side: "cand", status: 500 })],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues).toHaveLength(1);
  });

  it("emits evidence screenshots on divergence", () => {
    const r = httpStatusParity(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", status: 200, side: "prod", screenshotPath: "/p.png" })],
        candPages: [makePageCapture({ url: "https://x.com/", status: 500, side: "cand", screenshotPath: "/c.png" })],
      }),
    );
    expect(r.issues[0]?.evidence?.map((e) => e.path)).toEqual(["/p.png", "/c.png"]);
  });
});
