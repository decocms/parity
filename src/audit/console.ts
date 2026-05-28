import { classify, type ConsoleClass } from "../diff/console.ts";
import type { ConsoleEntry, Issue, Severity } from "../types/schema.ts";

/**
 * Audit console output from a single page load.
 *
 * Reuses `classify()` from `src/diff/console.ts` so the categorization
 * matches what the comparative checks use (hydration, not-found, csp,
 * request-failed, generic). Single-side severity rules:
 *
 *   hydration     → critical  (React #418/#421/etc — broken SSR pair)
 *   csp           → high      (Content-Security-Policy block)
 *   not-found     → high      (404 on a first-party resource)
 *   request-failed → medium   (network error; may be ad blocker, may be real)
 *   generic error → medium    (anything else with type=error)
 *   warning       → low       (visible but unlikely to break anything)
 *
 * Errors are deduplicated by classification + a normalized text key, so a
 * single re-thrown error doesn't create 20 issues.
 */
export function auditConsole(pageKey: string, entries: ConsoleEntry[]): Issue[] {
  const seen = new Map<string, { issue: Issue; count: number; firstEntry: ConsoleEntry }>();
  for (const entry of entries) {
    // Skip non-error/non-warning chatter — `info`, `log`, `debug` show up
    // in third-party scripts and aren't actionable for a deploy audit.
    if (entry.type !== "error" && entry.type !== "warning") continue;
    const cls = classify(entry);
    const sev = severityFor(cls, entry.type);
    const dedupKey = `${cls}:${normalizeForDedup(entry.text)}`;
    const existing = seen.get(dedupKey);
    if (existing) {
      existing.count++;
      continue;
    }
    seen.set(dedupKey, {
      count: 1,
      firstEntry: entry,
      issue: {
        id: `audit:console:${cls}:${pageKey}:${seen.size}`,
        severity: sev,
        category: "console",
        page: pageKey,
        check: "audit-console",
        summary: `[${cls}] ${truncate(entry.text, 200)}`,
        details: detailsFor(cls, entry),
      },
    });
  }
  const out: Issue[] = [];
  for (const { issue, count, firstEntry } of seen.values()) {
    if (count > 1) {
      const newSummary = `${issue.summary} (×${count})`;
      out.push({
        ...issue,
        summary: newSummary,
        details: `${issue.details}\n\nObservado ${count} vezes neste page load.`,
      });
    } else {
      void firstEntry;
      out.push(issue);
    }
  }
  return out;
}

function severityFor(cls: ConsoleClass, type: ConsoleEntry["type"]): Severity {
  if (type === "warning") return "low";
  switch (cls) {
    case "hydration":
      return "critical";
    case "csp":
      return "high";
    case "not-found":
      return "high";
    case "request-failed":
      return "medium";
    default:
      return "medium";
  }
}

function detailsFor(cls: ConsoleClass, entry: ConsoleEntry): string {
  const lines = [
    `Tipo: ${entry.type}`,
    `Classificação: ${cls}`,
    `Origem: ${entry.location ?? "(desconhecida)"}`,
    "",
    `Mensagem completa:\n${entry.text}`,
    "",
    HINTS[cls],
  ];
  return lines.join("\n");
}

const HINTS: Record<ConsoleClass, string> = {
  hydration:
    "Hydration mismatch: o HTML do SSR não bate com o que o React tentou hidratar. " +
    "Causas comuns no Deco: useDevice() no client (não tem userAgent do SSR), Date.now() ou " +
    "Math.random() no render, dangerouslySetInnerHTML usando dados da request. Ações: encapsular " +
    "código client-only em useEffect, usar mesma seed nos dois lados, ou suppressHydrationWarning.",
  csp:
    "Content-Security-Policy bloqueou um recurso. Adicionar o host à diretiva relevante " +
    "(script-src, connect-src, img-src, etc) ou remover o recurso. Atenção: bloqueio do " +
    "Google Analytics geralmente vem de ad-blocker do usuário, não é problema do site.",
  "not-found":
    "Recurso 404 (asset, script ou data fetch). Ações: confirmar que o arquivo existe no " +
    "deploy, checar paths absolutos vs relativos, verificar se cache está servindo path antigo.",
  "request-failed":
    "Request falhou em nível de network (não 404 — falha de conexão). Pode ser ERR_BLOCKED_BY_CLIENT " +
    "(ad blocker — não é bug), ERR_BLOCKED_BY_ORB (CORS-related), ERR_CONNECTION_REFUSED, ou DNS. " +
    "Investigar se é first-party (problema real) ou third-party trackers (geralmente ignorável).",
  generic:
    "Erro genérico não classificado. Inspecionar mensagem + stack trace pra identificar a causa.",
};

function normalizeForDedup(text: string): string {
  // Strip numbers, UUIDs, and timestamps so "Error 1234" and "Error 5678"
  // dedup to the same key. Aligns with src/diff/console.ts dedupKey logic.
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d{4,}\b/g, "<n>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .toLowerCase()
    .slice(0, 200);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
