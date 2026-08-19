import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSearchTerms } from "../../src/llm/resolve-search-terms.ts";

const SAMPLE_HTML = "<html><head><title>Loja</title></head><body><h1>Camisetas</h1></body></html>";

function mkTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "parity-search-terms-"));
}

describe("resolveSearchTerms", () => {
  it("usa override de rc.search.terms[0] sem chamar LLM", async () => {
    const dir = mkTmpDir();
    const r = await resolveSearchTerms("https://example.com", SAMPLE_HTML, {
      rc: {
        cep: "",
        selectors: {},
        skipSteps: [],
        search: { terms: ["palavra-magica"] },
      },
      cacheDir: dir,
      runId: "test-run-1",
    });
    expect(r.withResults).toBe("palavra-magica");
    expect(r.noResults).toContain("zzqxxq-");
  });

  it("usa cache quando existe", async () => {
    const dir = mkTmpDir();
    const cacheFile = join(dir, "search-terms-example.com.json");
    writeFileSync(cacheFile, JSON.stringify({ withResults: "cached-term" }), "utf8");
    const r = await resolveSearchTerms("https://example.com", SAMPLE_HTML, {
      cacheDir: dir,
      runId: "test-run-2",
    });
    expect(r.withResults).toBe("cached-term");
  });

  it("usa fallback PT-BR quando não há LLM e nem cache", async () => {
    // Garantir que não há API key no env neste teste
    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    const oldOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const dir = mkTmpDir();
      const r = await resolveSearchTerms("https://example.com", SAMPLE_HTML, {
        cacheDir: dir,
        runId: "test-run-3",
      });
      expect(r.withResults).toBeDefined();
      expect(r.withResults.length).toBeGreaterThan(0);
      // Cache file should NOT exist when we fell back
      expect(existsSync(join(dir, "search-terms-example.com.json"))).toBe(false);
    } finally {
      if (oldAnthropic) process.env.ANTHROPIC_API_KEY = oldAnthropic;
      if (oldOpenRouter) process.env.OPENROUTER_API_KEY = oldOpenRouter;
    }
  });

  it("noResults é determinístico para o mesmo runId", async () => {
    const dir = mkTmpDir();
    const r1 = await resolveSearchTerms("https://example.com", SAMPLE_HTML, {
      rc: { cep: "", selectors: {}, skipSteps: [], search: { terms: ["x"] } },
      cacheDir: dir,
      runId: "fixed-id",
    });
    const r2 = await resolveSearchTerms("https://example.com", SAMPLE_HTML, {
      rc: { cep: "", selectors: {}, skipSteps: [], search: { terms: ["x"] } },
      cacheDir: dir,
      runId: "fixed-id",
    });
    expect(r1.noResults).toBe(r2.noResults);
  });

  it("override de noResultsTerm sobrepõe gerador unicode", async () => {
    const dir = mkTmpDir();
    const r = await resolveSearchTerms("https://example.com", SAMPLE_HTML, {
      rc: {
        cep: "",
        selectors: {},
        skipSteps: [],
        search: { terms: ["x"], noResultsTerm: "minha-string-customizada" },
      },
      cacheDir: dir,
      runId: "any",
    });
    expect(r.noResults).toBe("minha-string-customizada");
  });
});
