import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTORS, selectorsFor } from "../../src/engine/selectors.ts";
import type { LearnedSelectors } from "../../src/learned/repo.ts";

describe("selectorsFor", () => {
  it("returns defaults when no rc / learned given", () => {
    const out = selectorsFor("categoryLink");
    expect(out[0]).toBe(DEFAULT_SELECTORS.categoryLink[0]);
    expect(out).toContain(DEFAULT_SELECTORS.categoryLink[1]);
  });

  it("user rc override comes first", () => {
    const out = selectorsFor("categoryLink", {
      rc: { cep: "", selectors: { categoryLink: "#cat" }, skipSteps: [] },
    });
    expect(out[0]).toBe("#cat");
  });

  it("learned entries follow user override and precede defaults", () => {
    const learned: LearnedSelectors = {
      schemaVersion: "0.1",
      platforms: {
        vtex: {
          categoryLink: [
            {
              selector: ".learned-a",
              confirmedHosts: [],
              successRate: 0.9,
              totalAttempts: 10,
              lastValidated: "2026-01-01",
            },
            {
              selector: ".learned-b",
              confirmedHosts: [],
              successRate: 0.5,
              totalAttempts: 10,
              lastValidated: "2026-01-01",
            },
          ],
        },
      },
    } as unknown as LearnedSelectors;

    const out = selectorsFor("categoryLink", {
      rc: { cep: "", selectors: { categoryLink: "#user" }, skipSteps: [] },
      learned,
      platform: "vtex",
    });
    expect(out[0]).toBe("#user");
    // learned comes next (sorted by successRate desc inside getLearnedSelectors)
    expect(out[1]).toBe(".learned-a");
    expect(out).toContain(".learned-b");
  });

  it("backwards-compat: accepts ParityRc directly as second arg", () => {
    const out = selectorsFor("buyButton", {
      cep: "",
      selectors: { buyButton: "#buy" },
      skipSteps: [],
    });
    expect(out[0]).toBe("#buy");
  });

  it("deduplicates selectors when same selector appears in multiple cascades", () => {
    const dupSelector = DEFAULT_SELECTORS.categoryLink[0]!;
    const out = selectorsFor("categoryLink", {
      rc: { cep: "", selectors: { categoryLink: dupSelector }, skipSteps: [] },
    });
    const count = out.filter((s) => s === dupSelector).length;
    expect(count).toBe(1);
  });

  it("returns defaults for every selector key", () => {
    const keys: Array<keyof typeof DEFAULT_SELECTORS> = [
      "categoryLink",
      "productCard",
      "buyButton",
      "minicartTrigger",
      "cepInputPdp",
      "cepInputCart",
      "checkoutButton",
    ];
    for (const k of keys) {
      const out = selectorsFor(k);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
