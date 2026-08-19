import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVERFN_FLOOD_BUDGET,
  DEFAULT_SERVERFN_PATTERN,
  countServerFnRequests,
  evaluateHoverFloodBudget,
} from "../../../src/checks/lib/serverfn-flood.ts";

describe("countServerFnRequests", () => {
  it("counts urls matching the default _serverFn pattern", () => {
    const urls = [
      "https://x.com/_serverFn/getProduct?id=1",
      "https://x.com/_serverFn/getProduct?id=2",
      "https://x.com/assets/logo.png",
    ];
    expect(countServerFnRequests(urls, DEFAULT_SERVERFN_PATTERN)).toBe(2);
  });

  it("is case-insensitive", () => {
    expect(countServerFnRequests(["https://x.com/_SERVERFN/x"], DEFAULT_SERVERFN_PATTERN)).toBe(1);
  });

  it("returns 0 for an empty list", () => {
    expect(countServerFnRequests([], DEFAULT_SERVERFN_PATTERN)).toBe(0);
  });

  it("supports a custom configured pattern", () => {
    const urls = ["https://x.com/api/rpc/getShelf", "https://x.com/_serverFn/x"];
    expect(countServerFnRequests(urls, "/api/rpc/")).toBe(1);
  });

  it("never throws on an invalid regex — degrades to 0 matches", () => {
    expect(countServerFnRequests(["https://x.com/_serverFn/x"], "(unterminated[")).toBe(0);
  });
});

describe("evaluateHoverFloodBudget", () => {
  it("does not exceed when count is within budget", () => {
    const r = evaluateHoverFloodBudget(5, DEFAULT_SERVERFN_FLOOD_BUDGET);
    expect(r.exceeded).toBe(false);
  });

  it("exceeds when count is over budget", () => {
    const r = evaluateHoverFloodBudget(30, DEFAULT_SERVERFN_FLOOD_BUDGET);
    expect(r.exceeded).toBe(true);
  });

  it("is not exceeded exactly at the budget boundary", () => {
    const r = evaluateHoverFloodBudget(
      DEFAULT_SERVERFN_FLOOD_BUDGET,
      DEFAULT_SERVERFN_FLOOD_BUDGET,
    );
    expect(r.exceeded).toBe(false);
  });

  it("respects a custom budget", () => {
    expect(evaluateHoverFloodBudget(3, 2).exceeded).toBe(true);
    expect(evaluateHoverFloodBudget(2, 2).exceeded).toBe(false);
  });
});
