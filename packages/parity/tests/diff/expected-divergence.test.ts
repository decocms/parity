import { describe, expect, it } from "vitest";
import {
  matchExpectedDivergence,
  partitionExpectedSections,
} from "../../src/diff/expected-divergence.ts";
import type { ExpectedDivergence } from "../../src/types/schema.ts";

const SHELF: ExpectedDivergence = {
  match: "ProductShelf",
  note: "better shelf, brought over from the other storefront",
};

describe("matchExpectedDivergence", () => {
  it("returns null when nothing is configured", () => {
    expect(matchExpectedDivergence(["ProductShelf"], [])).toBeNull();
  });

  it("matches a section name case-insensitively", () => {
    expect(matchExpectedDivergence(["productshelf"], [SHELF])?.note).toContain("better shelf");
  });

  it("matches inside LLM prose, so one rule covers one decision", () => {
    expect(
      matchExpectedDivergence(
        ["the ProductShelf uses a different card layout in cand", "main"],
        [SHELF],
      ),
    ).toBe(SHELF);
  });

  it("does not match an unrelated finding", () => {
    expect(matchExpectedDivergence(["footer newsletter is missing", "footer"], [SHELF])).toBeNull();
  });

  it("ignores undefined haystacks instead of throwing", () => {
    expect(matchExpectedDivergence([undefined, undefined], [SHELF])).toBeNull();
  });

  it("never lets an empty `match` swallow every finding", () => {
    const sloppy: ExpectedDivergence[] = [{ match: "   ", note: "oops" }];
    expect(matchExpectedDivergence(["anything at all"], sloppy)).toBeNull();
  });

  it("returns the first matching entry when several could apply", () => {
    const first: ExpectedDivergence = { match: "shelf", note: "first" };
    const second: ExpectedDivergence = { match: "productshelf", note: "second" };
    expect(matchExpectedDivergence(["ProductShelf"], [first, second])?.note).toBe("first");
  });
});

describe("partitionExpectedSections", () => {
  it("splits decided sections from the ones still worth reporting", () => {
    const out = partitionExpectedSections(["ProductShelf", "Newsletter", "Footer"], [SHELF]);
    expect(out.reportable).toEqual(["Newsletter", "Footer"]);
    expect(out.accepted).toEqual([
      { section: "ProductShelf", note: "better shelf, brought over from the other storefront" },
    ]);
  });

  it("reports everything when nothing is configured", () => {
    const out = partitionExpectedSections(["A", "B"], []);
    expect(out.reportable).toEqual(["A", "B"]);
    expect(out.accepted).toEqual([]);
  });
});
