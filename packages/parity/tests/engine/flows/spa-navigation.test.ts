import { describe, expect, it } from "vitest";
import {
  classifyNavigationType,
  computeSectionParityRegression,
  pickDifferentNavHref,
} from "../../../src/engine/flows/spa-navigation.ts";

describe("pickDifferentNavHref", () => {
  it("picks the first href whose path differs from the current URL", () => {
    const picked = pickDifferentNavHref(
      ["https://x.com/malas", "https://x.com/escolar"],
      "https://x.com/malas",
    );
    expect(picked).toBe("https://x.com/escolar");
  });

  it("skips hrefs with the same path (e.g. hash/query variants)", () => {
    const picked = pickDifferentNavHref(
      ["https://x.com/malas?utm=1", "https://x.com/malas#top", "https://x.com/escolar"],
      "https://x.com/malas",
    );
    expect(picked).toBe("https://x.com/escolar");
  });

  it("returns null when nothing differs", () => {
    const picked = pickDifferentNavHref(["https://x.com/malas"], "https://x.com/malas");
    expect(picked).toBeNull();
  });

  it("returns null for an empty candidate list", () => {
    expect(pickDifferentNavHref([], "https://x.com/malas")).toBeNull();
  });

  it("treats trailing slash as equivalent", () => {
    const picked = pickDifferentNavHref(["https://x.com/malas/"], "https://x.com/malas");
    expect(picked).toBeNull();
  });
});

describe("classifyNavigationType", () => {
  it("returns 'no-navigation' when the URL never changed", () => {
    expect(classifyNavigationType({ urlChanged: false, markerSurvived: true })).toBe(
      "no-navigation",
    );
  });

  it("returns 'spa' when the URL changed and the JS context marker survived", () => {
    expect(classifyNavigationType({ urlChanged: true, markerSurvived: true })).toBe("spa");
  });

  it("returns 'full-reload' when the URL changed but the marker was lost", () => {
    expect(classifyNavigationType({ urlChanged: true, markerSurvived: false })).toBe("full-reload");
  });
});

describe("computeSectionParityRegression", () => {
  it("flags a regression when the SPA-nav render has fewer network sections than F5", () => {
    const r = computeSectionParityRegression({
      f5NetworkSections: ["hero", "shelf", "footer"],
      f5DomCount: 3,
      spaNetworkSections: ["hero"],
      spaDomCount: 1,
    });
    expect(r.regression).toBe(true);
    expect(r.signalSource).toBe("network");
    expect(r.f5Signal).toBe(3);
    expect(r.spaSignal).toBe(1);
  });

  it("does not flag a regression when SPA-nav has equal or more sections", () => {
    const r = computeSectionParityRegression({
      f5NetworkSections: ["hero", "shelf"],
      f5DomCount: 2,
      spaNetworkSections: ["hero", "shelf"],
      spaDomCount: 2,
    });
    expect(r.regression).toBe(false);
  });

  it("falls back to DOM count when neither side has any network section markers", () => {
    const r = computeSectionParityRegression({
      f5NetworkSections: [],
      f5DomCount: 9,
      spaNetworkSections: [],
      spaDomCount: 6,
    });
    expect(r.signalSource).toBe("dom");
    expect(r.regression).toBe(true);
  });

  it("prefers network signal even when only one side produced any", () => {
    const r = computeSectionParityRegression({
      f5NetworkSections: ["hero"],
      f5DomCount: 1,
      spaNetworkSections: [],
      spaDomCount: 10,
    });
    expect(r.signalSource).toBe("network");
    // spa has 0 network sections vs f5's 1 → regression, even though DOM count would say otherwise
    expect(r.regression).toBe(true);
  });
});
