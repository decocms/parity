import { describe, expect, it } from "vitest";
import {
  collapseWhitespace,
  normalizeForCompare,
  normalizeUrl,
  sortClassAttribute,
  stripDynamicIds,
  stripHashes,
  stripTimestamps,
} from "../../src/engine/normalize.ts";

describe("stripTimestamps", () => {
  it("substitui ISO 8601", () => {
    expect(stripTimestamps("data: 2026-01-15T10:30:00Z hello")).toBe("data: __TS__ hello");
  });

  it("substitui epoch ms", () => {
    expect(stripTimestamps("ts=1736941200000 fim")).toBe("ts=__TS__ fim");
  });
});

describe("stripDynamicIds", () => {
  it("normaliza IDs dinâmicos curtos", () => {
    expect(stripDynamicIds("id=r-abc123def")).toBe("id=__DYN__");
  });

  it("normaliza UUIDs", () => {
    expect(stripDynamicIds("token: 550e8400-e29b-41d4-a716-446655440000")).toContain("__DYN__");
  });
});

describe("stripHashes", () => {
  it("normaliza assets com hash", () => {
    expect(stripHashes("/static/app.a1b2c3d4e5f6.js")).toBe("/static/app.__HASH__.js");
    expect(stripHashes("/img/photo-deadbeefcafe.webp")).toBe("/img/photo.__HASH__.webp");
  });
});

describe("sortClassAttribute", () => {
  it("ordena classes alfabeticamente", () => {
    expect(sortClassAttribute("c b a")).toBe("a b c");
    expect(sortClassAttribute("   b    a   ")).toBe("a b");
  });
});

describe("collapseWhitespace", () => {
  it("colapsa múltiplos espaços", () => {
    expect(collapseWhitespace("  a   b\n\tc  ")).toBe("a b c");
  });
});

describe("normalizeUrl", () => {
  it("remove tracking params e ordena restantes", () => {
    const u = normalizeUrl("https://x.com/p?utm_source=fb&z=2&a=1&gclid=xyz");
    expect(u).toContain("a=1");
    expect(u).toContain("z=2");
    expect(u).not.toContain("utm_source");
    expect(u).not.toContain("gclid");
    expect(u.indexOf("a=1")).toBeLessThan(u.indexOf("z=2"));
  });

  it("normaliza hashes em path", () => {
    expect(normalizeUrl("https://x.com/static/app.deadbeefcafe.js")).toContain("__HASH__.js");
  });

  it("retorna o input se não for URL válida", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("normalizeForCompare", () => {
  it("aplica timestamps + dynamic IDs + hashes + whitespace", () => {
    const out = normalizeForCompare("  timestamp 2026-01-15T10:30:00Z id r-abc123 file app.a1b2c3d4.js  ");
    expect(out).toContain("__TS__");
    expect(out).toContain("__DYN__");
    expect(out).toContain("__HASH__");
    expect(out.startsWith(" ")).toBe(false);
  });
});
