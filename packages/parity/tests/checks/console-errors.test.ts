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
            console: [
              { type: "error", text: "Hydration mismatch: server rendered X, client rendered Y" },
            ],
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

  it("dedupes the same error across pages into one issue with the affected-pages list", () => {
    const sharedError = "A chave utilizada não corresponde ao domínio: example.com";
    const r = consoleErrorsBaseline(
      makeContext({
        prodPages: [
          makePageCapture({ url: "https://x.com/", side: "prod" }),
          makePageCapture({ url: "https://x.com/s", side: "prod" }),
          makePageCapture({ url: "https://x.com/search", side: "prod" }),
        ],
        candPages: [
          makePageCapture({
            url: "https://x.com/",
            side: "cand",
            console: [{ type: "error", text: sharedError }],
          }),
          makePageCapture({
            url: "https://x.com/s",
            side: "cand",
            console: [{ type: "error", text: sharedError }],
          }),
          makePageCapture({
            url: "https://x.com/search",
            side: "cand",
            console: [{ type: "error", text: sharedError }],
          }),
        ],
      }),
    );
    // Previously this would emit 3 separate issues — one per page —
    // crowding the top-issues list with duplicates. Now it's a single
    // issue summarising all affected pages.
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.summary).toMatch(/3 páginas/);
    expect(r.issues[0]?.details).toContain("Observed on:");
    expect(r.issues[0]?.details).toContain("/");
    expect(r.issues[0]?.details).toContain("/s");
    expect(r.issues[0]?.details).toContain("/search");
  });
});
