import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FlowContext, findElement } from "../../../src/engine/flows/shared.ts";
import { buildStructuredError } from "../../../src/engine/interactive-selector-prompt.ts";

const CTX = { rc: {}, viewport: "mobile", side: "cand" } as unknown as FlowContext;

/** A page where nothing is ever visible, so `findElement` always exhausts its cascade. */
function emptyPage(url = "https://cand.example/p"): Page {
  return {
    url: () => url,
    content: async () => "<html><body><main>nada aqui</main></body></html>",
    locator: () => ({
      first: () => ({ isVisible: async () => false }),
      count: async () => 0,
    }),
  } as unknown as Page;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findElement — missing selector (#72)", () => {
  it("emits one structured record to stderr an agent can act on", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const hit = await findElement(emptyPage(), CTX, {
      key: "categoryLink",
      intent: "clicar num link de categoria da PLP",
      budget: { remaining: 0 },
    });

    expect(hit).toBeNull();
    const record = JSON.parse(written.at(-1) ?? "{}");
    expect(record.kind).toBe("missing-selector");
    expect(record.selectorKey).toBe("categoryLink");
    expect(record.intendedAction).toContain("link de categoria");
    expect(record.pageUrl).toBe("https://cand.example/p");
    // The agent needs somewhere to write the answer, not just the complaint.
    expect(record.suggestedRcPath).toMatch(/\.parityrc\.json$/);
    expect(record.htmlSnapshot).toContain("nada aqui");
  });

  it("reports a selector key once per process, not once per viewport and flow", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    for (let i = 0; i < 3; i++) {
      await findElement(emptyPage(), CTX, {
        key: "buyButton",
        intent: "clicar em comprar",
        budget: { remaining: 0 },
      });
    }

    const forKey = written.filter((w) => w.includes('"selectorKey":"buyButton"'));
    expect(forKey).toHaveLength(1);
  });

  it("stays quiet when there is no selector key to write an answer under", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const hit = await findElement(emptyPage(), CTX, {
      intent: "achar algo sem chave",
      extraSelectors: [".nada"],
      budget: { remaining: 0 },
    });

    expect(hit).toBeNull();
    // Without a key there is nowhere to persist an override, so a record would be noise.
    expect(written.filter((w) => w.includes("missing-selector"))).toEqual([]);
  });
});

describe("buildStructuredError", () => {
  it("caps the HTML so the record stays printable", () => {
    const err = buildStructuredError({
      selectorKey: "k",
      intendedAction: "a",
      alreadyTried: [],
      pageUrl: "https://x.example/",
      htmlSnapshot: "x".repeat(5000),
    });
    expect(err.htmlSnapshot).toHaveLength(2000);
  });

  it("keeps the selectors that were tried, so the answer is not a re-guess", () => {
    const err = buildStructuredError({
      selectorKey: "k",
      intendedAction: "a",
      alreadyTried: ["[data-x]", ".y"],
      pageUrl: "https://x.example/",
      htmlSnapshot: "",
    });
    expect(err.alreadyTried).toEqual(["[data-x]", ".y"]);
  });
});
