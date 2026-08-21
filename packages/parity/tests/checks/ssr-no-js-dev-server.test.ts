import { afterEach, describe, expect, it, vi } from "vitest";
import { ssrNoJs } from "../../src/checks/ssr-no-js.ts";
import { makeContext } from "../helpers/make-context.ts";
import { makePageCapture } from "../helpers/make-page-capture.ts";

/** `ssrNoJs` fetches the raw SSR HTML itself, so the fetch is what has to be faked. */
function stubFetch(bodyByUrl: Record<string, string>) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    const body = Object.entries(bodyByUrl).find(([k]) => url.startsWith(k))?.[1] ?? "";
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  });
}

function ctx(candUrl: string, prodBody: string, candBody: string) {
  stubFetch({ "https://prod.example": prodBody, [candUrl]: candBody });
  return makeContext({
    prodPages: [
      makePageCapture({
        url: "https://prod.example/",
        finalUrl: "https://prod.example/",
        side: "prod",
      }),
    ],
    candPages: [makePageCapture({ url: candUrl, finalUrl: candUrl, side: "cand" })],
  });
}

const RICH = `<html><body>${"conteúdo real ".repeat(200)}</body></html>`;
const BLANK = "<html><body><div id=root></div></body></html>";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ssrNoJs — dev-server candidate (#292)", () => {
  it("fails hard on a blank SSR body from a real host", async () => {
    const r = await ssrNoJs(ctx("https://cand.example/", RICH, BLANK));
    expect(r.status).toBe("fail");
    const blank = r.issues.find((i) => i.id === "ssr:blank");
    expect(blank?.severity).toBe("critical");
    expect(blank?.inconclusive).toBeUndefined();
  });

  it("keeps the finding but marks it inconclusive when the candidate is a dev server", async () => {
    const r = await ssrNoJs(ctx("http://localhost:3000/", RICH, BLANK));
    const blank = r.issues.find((i) => i.id === "ssr:blank");
    // Still reported — the reader wants to know — but it cannot be presented as a defect.
    expect(blank).toBeDefined();
    expect(blank?.inconclusive).toBe(true);
    expect(blank?.details).toContain("Reconfirme num build de produção");
    // `inconclusive` issues are excluded from the score, and must not fail the check either.
    expect(r.status).toBe("warn");
  });

  it("passes when the candidate's SSR body is as rich as prod's", async () => {
    const r = await ssrNoJs(ctx("http://localhost:3000/", RICH, RICH));
    expect(r.status).toBe("pass");
    expect(r.issues).toEqual([]);
  });
});
