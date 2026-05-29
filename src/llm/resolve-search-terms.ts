import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ParityRc } from "../types/schema.ts";
import { callTool, isLlmAvailable } from "./client.ts";
import { compactHtmlForSelectors } from "./discover-selectors.ts";

const CACHE_DIR = ".parity-cache";

/**
 * Terms used by `flowSearch`:
 *  - `withResults`: a single substantive keyword that very likely returns
 *    products on this store (e.g. "camisa", "tênis", "vinho").
 *  - `noResults`: a deterministic unicode string that should NEVER match
 *    a real product. Used to exercise the "no results" UI state.
 */
export interface ResolvedSearchTerms {
  withResults: string;
  noResults: string;
}

export interface ResolveSearchTermsOptions {
  rc?: ParityRc;
  /** Skip cache and always hit the LLM (still respects rc override). */
  noCache?: boolean;
  /** Override cache dir (test injection). */
  cacheDir?: string;
  /** Required for the deterministic no-results term so it doesn't conflict across runs. */
  runId?: string;
}

const FALLBACK_TERMS = ["produto", "preto", "promocao"];

function makeNoResults(runId: string | undefined): string {
  const id = (runId ?? Date.now().toString(36)).replace(/[^a-z0-9]/gi, "").slice(0, 12);
  return `zzqxxq-${id}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "_");
  } catch {
    return url.replace(/[^a-z0-9.-]/gi, "_").slice(0, 60);
  }
}

const TOOL = {
  name: "suggest_search_term",
  description:
    "Suggest a single keyword that, when typed in the site's search input, is very likely to return product results. Used by an automated parity test to exercise the search flow.",
  input_schema: {
    type: "object" as const,
    properties: {
      term: {
        type: "string",
        description:
          "A single common Portuguese (or English if the store is anglophone) noun that almost certainly has products. Prefer broad categories (camisa, tênis, vinho, livro, vestido). 1-2 words MAX. No special chars.",
      },
      reasoning: {
        type: "string",
        description: "1-sentence rationale tying the term to evidence in the markup.",
      },
    },
    required: ["term"],
  },
};

const SYSTEM_PROMPT = `
Você é um especialista em e-commerce. Recebe o HTML compactado da home de uma loja
e deve sugerir UMA palavra-chave (substantivo comum, 1-2 palavras) que tem altíssima
probabilidade de retornar produtos quando digitada na busca da loja.

REGRAS:
1. Prefira categorias amplas e óbvias da loja (ex: "camisa" pra moda, "vinho" pra adega).
2. Evite marcas específicas (podem não existir no catálogo após troca de fornecedor).
3. Evite termos promocionais ("oferta", "desconto") — costumam zerar resultados.
4. Use português brasileiro a menos que a loja seja claramente em outro idioma.
5. NÃO use acentos quando possível ("camisa" > "blusão").

Responda SEMPRE via tool_use suggest_search_term.
`.trim();

async function suggestTermViaLlm(
  url: string,
  html: string,
): Promise<string | null> {
  if (!isLlmAvailable()) return null;
  const compacted = compactHtmlForSelectors(html, 18_000);
  const input = await callTool<{ term?: string }>({
    systemPrompt: SYSTEM_PROMPT,
    userText: `URL: ${url}\n\nHTML compactado da home:\n\`\`\`html\n${compacted}\n\`\`\``,
    maxTokens: 200,
    tool: {
      name: TOOL.name,
      description: TOOL.description,
      inputSchema: TOOL.input_schema as unknown as Record<string, unknown>,
    },
  });
  const term = input?.term?.trim();
  if (!term) return null;
  // Strip anything that would break a URL or a CSS selector ("\"", "<", etc).
  const cleaned = term.replace(/[^\p{L}\p{N} -]/gu, "").trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, 30);
}

/**
 * Resolve a `with-results` search term and a deterministic `no-results` term
 * for `flowSearch`, following a cascade:
 *
 *   1. `rc.search.terms[0]` override (skip LLM entirely)
 *   2. `.parity-cache/search-terms-{host}.json` cache
 *   3. LLM suggestion (HTML compacted → keyword)
 *   4. Hardcoded PT-BR fallback
 *
 * The `noResults` term is ALWAYS generated deterministically from `runId` so
 * tests get a stable string that no real product can match.
 */
export async function resolveSearchTerms(
  url: string,
  html: string,
  opts: ResolveSearchTermsOptions = {},
): Promise<ResolvedSearchTerms> {
  const noResults = opts.rc?.search?.noResultsTerm?.trim() || makeNoResults(opts.runId);

  // 1. Override
  const overrideTerm = opts.rc?.search?.terms?.[0]?.trim();
  if (overrideTerm) {
    return { withResults: overrideTerm, noResults };
  }

  // 2. Cache
  const host = safeHost(url);
  const cacheDir = opts.cacheDir ?? CACHE_DIR;
  const cachePath = join(cacheDir, `search-terms-${host}.json`);
  if (!opts.noCache && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { withResults?: string };
      if (cached.withResults?.trim()) {
        return { withResults: cached.withResults.trim(), noResults };
      }
    } catch {
      /* ignore corrupt cache */
    }
  }

  // 3. LLM
  const suggested = await suggestTermViaLlm(url, html);
  if (suggested) {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      cachePath,
      `${JSON.stringify({ withResults: suggested, source: "llm" }, null, 2)}\n`,
      "utf8",
    );
    return { withResults: suggested, noResults };
  }

  // 4. Fallback
  return { withResults: FALLBACK_TERMS[0]!, noResults };
}

/** Exposed for tests. */
export const __TEST__ = { FALLBACK_TERMS, makeNoResults };
