/**
 * `DeckModel` — the narrow view a presentation deck needs, derived from a `Run`. Issues #289/#290.
 *
 * `report.json` is an engineering artifact: 80+ raw issues, 34 checks, per-page captures. A deck
 * page shows four tiles and eight rows. Reaching into the run from the renderer would put that
 * reduction in the template, where it is invisible and untestable, so the reduction lives here and
 * the renderer stays dumb.
 *
 * What this deliberately does NOT do is invent narrative. Section prose, the before/after mapping
 * and the "why" column are human judgment; a generator that guesses them produces a document
 * nobody trusts. The deck carries what the run measured, and leaves space for the rest.
 */

import type { Issue, Run, RunCaveat, Severity } from "../types/schema.ts";

export interface DeckTile {
  value: string;
  label: string;
  sub: string;
  tone: "good" | "warn" | "bad" | "neutral";
}

export interface DeckModule {
  module: string;
  score: number;
  status: string;
  tone: "good" | "warn" | "bad";
}

export interface DeckFinding {
  severity: Severity;
  category: string;
  summary: string;
  /** Findings the run itself flagged as untrustworthy — rendered as a caveat, not a defect. */
  inconclusive: boolean;
}

export interface DeckModel {
  prodUrl: string;
  candUrl: string;
  timestamp: string;
  runId: string;
  score: number;
  status: string;
  /** Conditions limiting how far these numbers go — from `Run.caveats` (#292). */
  caveats: RunCaveat[];
  headline: DeckTile[];
  modules: DeckModule[];
  findings: DeckFinding[];
  /** Findings above the cap, stated rather than silently dropped. */
  findingsOmitted: number;
  visual: { pagesChecked: number; pagesPassed: number; pagesWithDiffs: number } | null;
}

/** How many findings a deck page can hold before it stops being readable. */
const MAX_FINDINGS = 12;

function toneForStatus(status: string): "good" | "warn" | "bad" {
  if (status === "pass") return "good";
  if (status === "warn") return "warn";
  return "bad";
}

export function buildDeckModel(run: Run): DeckModel {
  const v = run.verdict;

  // Ranked, deduped findings first — `topIssues` is what the run already decided matters. Fall
  // back to the raw list so a run without ranking still produces a deck.
  const source = run.topIssues.length > 0 ? run.topIssues : run.issues;
  const ranked = [...source].sort(bySeverity);
  const findings: DeckFinding[] = ranked.slice(0, MAX_FINDINGS).map((i) => ({
    severity: i.severity,
    category: i.category,
    summary: i.summary,
    inconclusive: Boolean(i.inconclusive),
  }));

  return {
    prodUrl: run.prodUrl,
    candUrl: run.candUrl,
    timestamp: run.timestamp,
    runId: run.id,
    score: v.score,
    status: v.status,
    caveats: run.caveats ?? [],
    headline: [
      {
        value: `${v.score}/100`,
        label: "score parity",
        sub: v.pagesAnalyzed ? `${v.pagesAnalyzed} páginas analisadas` : "",
        tone: toneForStatus(v.status),
      },
      {
        value: String(v.critical),
        label: "critical",
        sub: "bloqueiam launch",
        tone: v.critical > 0 ? "bad" : "good",
      },
      {
        value: String(v.high),
        label: "high",
        sub: "corrigir antes de produção",
        tone: v.high > 0 ? "warn" : "good",
      },
      {
        value: `${v.checksPassed}/${v.checksRun}`,
        label: "checks passados",
        // A skipped check is not a passing one, so it is stated rather than folded into the ratio.
        sub: v.checksSkipped > 0 ? `${v.checksSkipped} pulados` : "",
        tone: v.checksFailed > 0 ? "bad" : "good",
      },
    ],
    modules: (run.moduleVerdicts ?? []).map((m) => ({
      module: m.module,
      score: m.score,
      status: m.status,
      tone: toneForStatus(m.status),
    })),
    findings,
    findingsOmitted: Math.max(0, ranked.length - findings.length),
    visual: run.visualDiff
      ? {
          pagesChecked: run.visualDiff.pagesChecked,
          pagesPassed: run.visualDiff.pagesPassed,
          pagesWithDiffs: run.visualDiff.pagesWithDiffs,
        }
      : null,
  };
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Severity first, then conclusive before inconclusive: a finding the run could not stand behind
 * should never outrank one it could, at the same severity.
 */
function bySeverity(a: Issue, b: Issue): number {
  const bySev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySev !== 0) return bySev;
  return Number(Boolean(a.inconclusive)) - Number(Boolean(b.inconclusive));
}
