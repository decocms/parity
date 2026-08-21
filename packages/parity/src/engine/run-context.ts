/**
 * Run caveats — the conditions that make a number in this run less trustworthy than it looks.
 * Issue #292.
 *
 * Every one of these is already known at run time and was already in `report.json` somewhere; what
 * was missing is saying it out loud. A score measured against a dev server, or with different
 * content on each side, or with whole modules skipped because no LLM was configured, is not
 * comparable to one measured properly — and the reader has no way to tell from the number.
 *
 * This is deliberately not a scoring change. It labels the run; it does not move the verdict.
 */

import type { PageCapture, Verdict } from "../types/schema.ts";
import { isLocalhost } from "../util/localhost.ts";

export interface RunCaveat {
  id: string;
  /** `warn` — a number in this run is probably not comparable. `info` — worth knowing, not alarming. */
  level: "warn" | "info";
  summary: string;
  detail: string;
}

export interface DetectRunCaveatsInput {
  prodUrl: string;
  candUrl: string;
  prodPages: PageCapture[];
  candPages: PageCapture[];
  verdict?: Pick<Verdict, "checksRun" | "checksSkipped"> | null;
  /** False when no LLM provider was configured or visual pages were zeroed out. */
  llmEnabled: boolean;
  partial?: boolean;
  partialReason?: string;
}

export function detectRunCaveats(input: DetectRunCaveatsInput): RunCaveat[] {
  const out: RunCaveat[] = [];

  if (isLocalhost(input.candUrl)) {
    out.push({
      id: "cand-dev-server",
      level: "warn",
      summary: "Candidato medido num dev server",
      detail:
        "Vitals, cache e bundle de um dev server não são representativos: sem minificação, sem cache de edge, HMR aberto. Reconfirme num build de produção antes de tratar qualquer número de performance como resultado.",
    });
  }
  if (isLocalhost(input.prodUrl)) {
    out.push({
      id: "prod-dev-server",
      level: "warn",
      summary: "Referência (prod) medida num dev server",
      detail:
        "O lado de referência também é local, então a comparação mede duas máquinas de desenvolvimento — útil para regressão relativa, não para números absolutos.",
    });
  }

  const mismatched = pairedPathMismatches(input.prodPages, input.candPages);
  if (mismatched.length > 0) {
    out.push({
      id: "paths-differ",
      level: "warn",
      summary: `${mismatched.length} página(s) comparadas em caminhos diferentes`,
      detail: `Os dois lados não estão no mesmo conteúdo (${mismatched
        .slice(0, 3)
        .join(", ")}${mismatched.length > 3 ? "…" : ""}). O módulo visual vai apontar diferenças que são de produto, não de migração — leia estrutura e hierarquia, não conteúdo.`,
    });
  }

  if (!input.llmEnabled) {
    out.push({
      id: "llm-disabled",
      level: "info",
      summary: "Sem provedor de LLM — módulos visuais não rodaram",
      detail:
        "Visual diff e ranking de issues dependem de LLM. Sem provedor configurado eles são pulados, então a ausência de achados visuais não significa paridade visual.",
    });
  }

  const skipped = input.verdict?.checksSkipped ?? 0;
  if (skipped > 0) {
    out.push({
      id: "checks-skipped",
      level: "info",
      summary: `${skipped} de ${input.verdict?.checksRun ?? "?"} checks pulados`,
      detail:
        "Um check pulado não é um check que passou. Veja `checks[]` no report.json para quais e por quê.",
    });
  }

  if (input.partial) {
    out.push({
      id: "partial-run",
      level: "warn",
      summary: "Run interrompido — veredito parcial",
      detail: input.partialReason
        ? `Parou em: ${input.partialReason}. O que não rodou não conta como aprovado.`
        : "O que não rodou não conta como aprovado.",
    });
  }

  return out;
}

/**
 * Page pairs whose prod and cand paths differ. A partial migration routinely compares a reference
 * PDP against a product the candidate has not ported, which is legitimate — but it means the
 * visual verdict is about two different products, and that has to be said.
 */
function pairedPathMismatches(prodPages: PageCapture[], candPages: PageCapture[]): string[] {
  const out: string[] = [];
  for (const cand of candPages) {
    if (!cand.pairKey) continue;
    const prod = prodPages.find((p) => p.pairKey === cand.pairKey);
    if (!prod) continue;
    const prodPath = pathOf(prod.url);
    const candPath = pathOf(cand.url);
    if (prodPath && candPath && prodPath !== candPath) out.push(`${prodPath} → ${candPath}`);
  }
  return [...new Set(out)];
}

function pathOf(raw: string): string | null {
  try {
    return new URL(raw).pathname;
  } catch {
    return null;
  }
}
