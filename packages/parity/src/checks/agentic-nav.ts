import type { AgentA11yAudit, CheckResult, Issue } from "../types/schema.ts";
import type { CheckContext } from "./index.ts";

/**
 * "Navegação agêntica" — is the candidate navigable/parseable by AI agents?
 * A composite of the signals parity can measure, mirroring PageSpeed's
 * in-development category:
 *   1. Agent accessibility — the accessibility tree exposes discernible names
 *      for buttons/links and labels for inputs (Lighthouse agent-a11y audits).
 *   2. llms.txt quality — a well-formed /llms.txt (https://llmstxt.org) so an
 *      agent gets a curated map of the site.
 * WebMCP integration validity (deco-specific) isn't measured here.
 *
 * Async: fetches cand /llms.txt. Only meaningful in Lighthouse mode (agent-a11y
 * comes from the Lighthouse pass); with `--no-lighthouse` pillar 1 is skipped.
 */
export async function agenticNav(ctx: CheckContext): Promise<CheckResult> {
  const start = Date.now();
  const issues: Issue[] = [];
  const pillars: {
    key: string;
    label: string;
    ok: boolean;
    applicable: boolean;
    failingAudits?: AgentA11yAudit[];
    note?: string;
  }[] = [];

  // Pillar 1 — agent accessibility tree (from Lighthouse audits on cand pages).
  const withA11y = ctx.candPages.filter((p) => p.agentA11y && p.agentA11y.length > 0);
  if (withA11y.length > 0) {
    // Worst instance per audit id across cand pages (a fail anywhere = fail).
    const byId = new Map<string, AgentA11yAudit>();
    for (const p of withA11y) {
      for (const a of p.agentA11y ?? []) {
        const prev = byId.get(a.id);
        // Keep the failing one if any page fails; else keep whatever we have.
        if (!prev || (a.score === 0 && prev.score !== 0)) byId.set(a.id, a);
      }
    }
    const failing = [...byId.values()].filter((a) => a.score === 0);
    pillars.push({
      key: "agent-a11y",
      label: "Agent accessibility",
      ok: failing.length === 0,
      applicable: true,
      failingAudits: failing,
    });
    if (failing.length > 0) {
      issues.push({
        id: "agentic:a11y-tree",
        severity: "medium",
        category: "a11y",
        check: "agentic-nav",
        summary: `Árvore de acessibilidade mal estruturada para agentes: ${failing.map((f) => f.id).join(", ")}`,
        details: failing
          .map(
            (f) =>
              `${f.title}\n  ${f.elements
                .map((e) => e.selector)
                .filter(Boolean)
                .join("\n  ")}`,
          )
          .join("\n"),
      });
    }
  } else {
    pillars.push({
      key: "agent-a11y",
      label: "Agent accessibility",
      ok: false,
      applicable: false,
      note: "no Lighthouse data (run without --no-lighthouse)",
    });
  }

  // Pillar 2 — llms.txt quality on cand.
  const candOrigin = originOf(ctx.candPages);
  const llms = candOrigin ? await fetchLlmsTxtQuality(candOrigin) : null;
  const llmsOk = !!llms?.wellFormed;
  pillars.push({
    key: "llms-txt",
    label: "llms.txt follows recommendations",
    ok: llmsOk,
    applicable: true,
    note: llms?.reason,
  });
  if (!llmsOk) {
    issues.push({
      id: "agentic:llms-txt",
      severity: "low",
      category: "seo",
      check: "agentic-nav",
      summary: llms?.present
        ? "O arquivo llms.txt não segue as recomendações"
        : "cand não serve /llms.txt",
      details: `${llms?.reason ?? "ausente"}. Veja https://llmstxt.org — um H1 de título, um resumo em blockquote e seções com links.`,
    });
  }

  const applicable = pillars.filter((p) => p.applicable);
  const passed = applicable.filter((p) => p.ok).length;
  return {
    name: "agentic-nav",
    status: applicable.length === 0 ? "skipped" : passed === applicable.length ? "pass" : "fail",
    severity: "medium",
    durationMs: Date.now() - start,
    summary: `Navegação agêntica: ${passed}/${applicable.length} verificações`,
    issues,
    data: { agentic: { passed, total: applicable.length, pillars } },
  };
}

function originOf(pages: { url: string }[]): string | null {
  for (const p of pages) {
    try {
      return new URL(p.url).origin;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Fetch and validate /llms.txt against the llmstxt.org shape: a Markdown file
 * starting with an `# H1` title, ideally a summary and `## ` sections with
 * `[links](…)`. Rejects SPA index.html fallbacks (served for unknown routes).
 */
async function fetchLlmsTxtQuality(
  origin: string,
  timeoutMs = 10_000,
): Promise<{ present: boolean; wellFormed: boolean; reason: string }> {
  const url = new URL("/llms.txt", origin).toString();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "parity-cli/0.1" },
    });
    if (!res.ok) return { present: false, wellFormed: false, reason: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    if (ct.includes("text/html") || body.trimStart().startsWith("<")) {
      return {
        present: false,
        wellFormed: false,
        reason: "route returns HTML (SPA fallback), not an llms.txt",
      };
    }
    return assessLlmsTxt(body);
  } catch {
    return { present: false, wellFormed: false, reason: "fetch failed" };
  } finally {
    clearTimeout(t);
  }
}

/** Pure llms.txt shape check — exported for testing. */
export function assessLlmsTxt(body: string): {
  present: boolean;
  wellFormed: boolean;
  reason: string;
} {
  const text = body.trim();
  if (text.length === 0) return { present: false, wellFormed: false, reason: "empty" };
  const lines = text.split(/\r?\n/);
  const firstMeaningful = lines.find((l) => l.trim().length > 0) ?? "";
  const hasH1 = /^#\s+\S/.test(firstMeaningful.trim());
  const hasLinks = /\[[^\]]+\]\([^)]+\)/.test(text);
  const hasSection = /^##\s+\S/m.test(text);
  const wellFormed = hasH1 && (hasLinks || hasSection);
  const missing: string[] = [];
  if (!hasH1) missing.push("H1 title (`# Title`)");
  if (!hasLinks && !hasSection) missing.push("`##` sections or `[text](url)` links");
  return {
    present: true,
    wellFormed,
    reason: wellFormed ? "ok" : `missing ${missing.join(" and ")}`,
  };
}
