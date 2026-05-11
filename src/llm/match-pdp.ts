import { extractJsonLd } from "../diff/jsonld.ts";
import { callTool } from "./client.ts";

export interface PdpFingerprint {
  name: string | null;
  price: number | null;
  sku: string | null;
}

export type MatchVerdict = "same" | "similar" | "different";

/**
 * Extract a minimal Product fingerprint from raw HTML, preferring JSON-LD when present.
 */
export function fingerprintPdp(html: string): PdpFingerprint {
  const out: PdpFingerprint = { name: null, price: null, sku: null };
  const jsonLd = extractJsonLd(html);
  const product = jsonLd.get("Product")?.[0];
  if (product) {
    if (typeof product.name === "string") out.name = product.name;
    if (typeof product.sku === "string") out.sku = product.sku;
    else if (typeof product.sku === "number") out.sku = String(product.sku);
    const offers = product.offers as Record<string, unknown> | undefined;
    if (offers) {
      const priceVal = offers.price;
      if (typeof priceVal === "number") out.price = priceVal;
      else if (typeof priceVal === "string") {
        const n = Number(priceVal.replace(",", "."));
        if (Number.isFinite(n)) out.price = n;
      }
    }
  }
  return out;
}

/**
 * Compare two PDP fingerprints. Deterministic Levenshtein on names + SKU exact
 * match first; falls back to LLM when ambiguous.
 */
export async function matchPdps(prod: PdpFingerprint, cand: PdpFingerprint): Promise<MatchVerdict> {
  // SKU exact match is the strongest signal
  if (prod.sku && cand.sku && prod.sku === cand.sku) return "same";

  // No name on either side — can't compare
  if (!prod.name || !cand.name) return "different";

  const sim = nameSimilarity(prod.name, cand.name);
  if (sim >= 0.95) return "same";
  if (sim >= 0.8) {
    // ambiguous — ask LLM
    const verdict = await llmMatch(prod, cand);
    return verdict ?? "similar";
  }
  if (sim >= 0.6) {
    const verdict = await llmMatch(prod, cand);
    return verdict ?? "different";
  }
  return "different";
}

function nameSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen;
}

function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\u0300-\u036f/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n]!;
}

async function llmMatch(prod: PdpFingerprint, cand: PdpFingerprint): Promise<MatchVerdict | null> {
  const input = await callTool<{ verdict?: string }>({
    systemPrompt:
      "Você classifica se duas páginas de produto (PDPs) mostram o mesmo produto. 'same' = mesmo SKU/produto idêntico. 'similar' = variação (mesma família, cor diferente, embalagem diferente). 'different' = produtos distintos.",
    userText: `prod: ${JSON.stringify(prod)}\ncand: ${JSON.stringify(cand)}`,
    maxTokens: 200,
    tool: {
      name: "classify_pdp_match",
      description: "Classify whether two PDPs show the same product",
      inputSchema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["same", "similar", "different"] },
          reasoning: { type: "string" },
        },
        required: ["verdict"],
      },
    },
  });
  const verdict = input?.verdict;
  if (verdict === "same" || verdict === "similar" || verdict === "different") {
    return verdict;
  }
  return null;
}
