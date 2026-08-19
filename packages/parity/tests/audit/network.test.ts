import { describe, expect, it } from "vitest";
import { auditNetwork } from "../../src/audit/network.ts";
import type { NetworkEntry } from "../../src/types/schema.ts";

function entry(over: Partial<NetworkEntry>): NetworkEntry {
  return {
    url: "https://example.com/x",
    method: "GET",
    status: 200,
    resourceType: "fetch",
    fromCache: false,
    bytes: 1000,
    durationMs: 100,
    cacheControl: null,
    serverTiming: null,
    decoSection: null,
    ...over,
  };
}

describe("auditNetwork", () => {
  const PAGE_URL = "https://example.com/";

  it("retorna vazio sem entries", () => {
    expect(auditNetwork("/::mobile", PAGE_URL, [])).toEqual([]);
  });

  it("flagga erros first-party 5xx como high", () => {
    const r = auditNetwork("/::mobile", PAGE_URL, [
      entry({ url: "https://example.com/api/x", status: 500 }),
    ]);
    const issue = r.find((i) => i.id.includes(":fp-error:"));
    expect(issue?.severity).toBe("high");
  });

  it("flagga erros first-party 4xx como medium", () => {
    const r = auditNetwork("/::mobile", PAGE_URL, [
      entry({ url: "https://example.com/api/x", status: 404 }),
    ]);
    const issue = r.find((i) => i.id.includes(":fp-error:"));
    expect(issue?.severity).toBe("medium");
  });

  it("agrega third-party errors em 1 issue low", () => {
    const r = auditNetwork("/::mobile", PAGE_URL, [
      entry({ url: "https://google-analytics.com/x", status: 0 }),
      entry({ url: "https://facebook.com/y", status: 0 }),
      entry({ url: "https://twitter.com/z", status: 403 }),
    ]);
    const issue = r.find((i) => i.id.includes(":tp-errors:"));
    expect(issue?.severity).toBe("low");
    expect(issue?.summary).toMatch(/3 third-party/);
  });

  it("flagga slow requests >3s como medium (1-3)", () => {
    const r = auditNetwork("/::mobile", PAGE_URL, [
      entry({ url: "https://example.com/api", durationMs: 5_000 }),
    ]);
    const issue = r.find((i) => i.id.includes(":slow:"));
    expect(issue?.severity).toBe("medium");
  });

  it("escala slow requests >3 ocorrências para high", () => {
    const r = auditNetwork(
      "/::mobile",
      PAGE_URL,
      Array.from({ length: 4 }, (_, i) =>
        entry({ url: `https://example.com/${i}`, durationMs: 5_000 }),
      ),
    );
    const issue = r.find((i) => i.id.includes(":slow:"));
    expect(issue?.severity).toBe("high");
  });

  it("flagga page bloat >5MB como medium", () => {
    const r = auditNetwork(
      "/::mobile",
      PAGE_URL,
      Array.from({ length: 50 }, () => entry({ bytes: 200_000 })),
    );
    const issue = r.find((i) => i.id.includes(":bloat:"));
    expect(issue?.severity).toBe("medium");
  });

  it("flagga cache hit rate baixo quando há >10 static assets", () => {
    const r = auditNetwork(
      "/::mobile",
      PAGE_URL,
      Array.from({ length: 15 }, (_, i) =>
        entry({
          url: `https://example.com/${i}.js`,
          resourceType: "script",
          fromCache: i < 3, // 20% hit rate
        }),
      ),
    );
    const issue = r.find((i) => i.id.includes(":cache:"));
    expect(issue?.severity).toBe("medium");
    expect(issue?.summary).toMatch(/20%/);
  });

  it("NÃO flagga cache quando há <10 assets estáticos", () => {
    const r = auditNetwork(
      "/::mobile",
      PAGE_URL,
      Array.from({ length: 5 }, (_, i) =>
        entry({
          url: `https://example.com/${i}.js`,
          resourceType: "script",
          fromCache: false,
        }),
      ),
    );
    const issue = r.find((i) => i.id.includes(":cache:"));
    expect(issue).toBeUndefined();
  });

  it("subdomínios são considerados first-party", () => {
    const r = auditNetwork("/::mobile", "https://example.com/", [
      entry({ url: "https://cdn.example.com/api/x", status: 500 }),
    ]);
    const fpIssue = r.find((i) => i.id.includes(":fp-error:"));
    expect(fpIssue).toBeDefined();
  });
});
