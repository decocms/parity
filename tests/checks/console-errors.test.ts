import { describe, expect, it } from "vitest";
import { consoleErrorsBaseline } from "../../src/checks/console-errors.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

describe("consoleErrorsBaseline", () => {
  it("passes when cand has no new errors", () => {
    const r = consoleErrorsBaseline(
      makeContext({
        prodPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "prod",
            console: [{ type: "error", text: "shared error" }],
          }),
        ],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            console: [{ type: "error", text: "shared error" }],
          }),
        ],
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("fails when cand has a new error not in prod", () => {
    const r = consoleErrorsBaseline(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod", console: [] })],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            console: [{ type: "error", text: "TypeError: cannot read property foo of undefined" }],
          }),
        ],
      }),
    );
    expect(r.status).toBe("fail");
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it("flags hydration errors as critical severity", () => {
    const r = consoleErrorsBaseline(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod" })],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            console: [{ type: "error", text: "Hydration mismatch: server rendered X, client rendered Y" }],
          }),
        ],
      }),
    );
    expect(r.issues[0]?.severity).toBe("critical");
  });

  it("respects ignoreConsolePatterns", () => {
    const r = consoleErrorsBaseline(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod" })],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            console: [{ type: "error", text: "ERR_BLOCKED_BY_CLIENT some tracker" }],
          }),
        ],
        ignore: { ignoreConsolePatterns: ["ERR_BLOCKED_BY_CLIENT"] },
      }),
    );
    expect(r.status).toBe("pass");
  });

  it("ignores warnings (errors only)", () => {
    const r = consoleErrorsBaseline(
      makeContext({
        prodPages: [makePageCapture({ url: "https://x.com/", side: "prod" })],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            console: [{ type: "warning", text: "Deprecation warning: ..." }],
          }),
        ],
      }),
    );
    expect(r.status).toBe("pass");
  });
});
