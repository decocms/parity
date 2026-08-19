import { describe, expect, it } from "vitest";
import { pickDifferentProductHref } from "../../../src/engine/flows/cart-interactions.ts";

describe("pickDifferentProductHref", () => {
  it("returns the first href that differs from the excluded one", () => {
    const hrefs = ["/p/a", "/p/b", "/p/c"];
    expect(pickDifferentProductHref(hrefs, "/p/a")).toBe("/p/b");
  });

  it("skips leading duplicates of the excluded href", () => {
    const hrefs = ["/p/a", "/p/a", "/p/b"];
    expect(pickDifferentProductHref(hrefs, "/p/a")).toBe("/p/b");
  });

  it("returns null when every href matches the excluded one", () => {
    const hrefs = ["/p/a", "/p/a"];
    expect(pickDifferentProductHref(hrefs, "/p/a")).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickDifferentProductHref([], "/p/a")).toBeNull();
  });

  it("returns the only href when it differs from the excluded one", () => {
    expect(pickDifferentProductHref(["/p/z"], "/p/a")).toBe("/p/z");
  });
});
