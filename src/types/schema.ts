import { z } from "zod";

export const Severity = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

export const Category = z.enum([
  "functional",
  "visual",
  "performance",
  "seo",
  "console",
  "network",
]);
export type Category = z.infer<typeof Category>;

export const Viewport = z.enum(["mobile", "tablet", "desktop"]);
export type Viewport = z.infer<typeof Viewport>;

export const FlowName = z.enum(["homepage", "plp", "pdp", "purchase-journey"]);
export type FlowName = z.infer<typeof FlowName>;

export const Side = z.enum(["prod", "cand"]);
export type Side = z.infer<typeof Side>;

export const WebVitals = z.object({
  lcp: z.number().nullable(),
  cls: z.number().nullable(),
  fcp: z.number().nullable(),
  ttfb: z.number().nullable(),
  inp: z.number().nullable(),
});
export type WebVitals = z.infer<typeof WebVitals>;

export const ConsoleEntry = z.object({
  type: z.enum(["error", "warning", "log", "info", "debug"]),
  text: z.string(),
  location: z.string().optional(),
});
export type ConsoleEntry = z.infer<typeof ConsoleEntry>;

export const NetworkEntry = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number(),
  resourceType: z.string(),
  fromCache: z.boolean(),
  bytes: z.number().nullable(),
  durationMs: z.number().nullable(),
  cacheControl: z.string().nullable(),
  serverTiming: z.string().nullable(),
  decoSection: z.string().nullable(),
});
export type NetworkEntry = z.infer<typeof NetworkEntry>;

export const PageCapture = z.object({
  url: z.string(),
  finalUrl: z.string(),
  status: z.number(),
  viewport: Viewport,
  side: Side,
  durationMs: z.number(),
  html: z.string(),
  vitals: WebVitals,
  console: z.array(ConsoleEntry),
  network: z.array(NetworkEntry),
  screenshotPath: z.string(),
  harPath: z.string().optional(),
  tracePath: z.string().optional(),
  xRobotsTag: z.string().nullable().optional(),
});
export type PageCapture = z.infer<typeof PageCapture>;

export const StepCapture = z.object({
  step: z.number(),
  name: z.string(),
  side: Side,
  viewport: Viewport,
  status: z.enum(["ok", "skipped", "failed"]),
  durationMs: z.number(),
  url: z.string().optional(),
  screenshotPath: z.string(),
  note: z.string().optional(),
  detail: z.record(z.unknown()).optional(),
  /** Selector key that this step used, if applicable (for learned-selectors promotion) */
  selectorKey: z.string().optional(),
  /** The actual selector string that worked for this step */
  usedSelector: z.string().optional(),
  /** True when the selector came from LLM recovery (so it gets promoted explicitly) */
  recoveredByLlm: z.boolean().optional(),
  /** Human-readable description of what was executed (for trace display) */
  actionDescription: z.string().optional(),
  /** URL the page was on BEFORE this step ran */
  beforeUrl: z.string().optional(),
  /** Screenshot taken BEFORE the action (only for interactive steps) */
  screenshotBeforePath: z.string().optional(),
  /** Path to the Playwright trace .zip for this flow */
  tracePath: z.string().optional(),
});
export type StepCapture = z.infer<typeof StepCapture>;

export const FlowCapture = z.object({
  flow: FlowName,
  side: Side,
  viewport: Viewport,
  pages: z.array(PageCapture),
  steps: z.array(StepCapture).optional(),
  totalDurationMs: z.number(),
});
export type FlowCapture = z.infer<typeof FlowCapture>;

export const EvidenceRef = z.object({
  kind: z.enum(["screenshot", "har", "trace", "console", "network", "html"]),
  path: z.string(),
  label: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const Issue = z.object({
  id: z.string(),
  severity: Severity,
  category: Category,
  page: z.string().optional(),
  check: z.string(),
  summary: z.string(),
  details: z.string().optional(),
  evidence: z.array(EvidenceRef).optional(),
  reproduction: z.string().optional(),
  suggestedFix: z.string().optional(),
});
export type Issue = z.infer<typeof Issue>;

export const CheckResult = z.object({
  name: z.string(),
  status: z.enum(["pass", "fail", "warn", "skipped"]),
  severity: Severity,
  durationMs: z.number(),
  summary: z.string(),
  data: z.record(z.unknown()).optional(),
  issues: z.array(Issue),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const VisualDifferenceType = z.enum([
  "missing-component",
  "different-component",
  "extra-component",
  "layout-shift",
  "text-changed",
  "color-style-diff",
  "image-diff",
  "cosmetic",
]);
export type VisualDifferenceType = z.infer<typeof VisualDifferenceType>;

export const VisualRegion = z.enum([
  "header",
  "hero",
  "navigation",
  "main",
  "shelf",
  "footer",
  "sidebar",
  "modal",
  "minicart",
  "other",
]);
export type VisualRegion = z.infer<typeof VisualRegion>;

export const VisualDifference = z.object({
  type: VisualDifferenceType,
  region: VisualRegion,
  severity: Severity,
  description: z.string(),
});
export type VisualDifference = z.infer<typeof VisualDifference>;

export const VisualDiffPage = z.object({
  pageKey: z.string(),
  pagePath: z.string(),
  pageLabel: z.string(),
  viewport: Viewport,
  prodUrl: z.string(),
  candUrl: z.string(),
  prodScreenshotPath: z.string(),
  candScreenshotPath: z.string(),
  heatmapPath: z.string().optional(),
  pctDiff: z.number(),
  verdict: z.enum(["pass", "diffs", "failed"]),
  prodSections: z.array(z.string()),
  candSections: z.array(z.string()),
  sectionsOnlyInProd: z.array(z.string()),
  sectionsOnlyInCand: z.array(z.string()),
  differences: z.array(VisualDifference),
  llmCalled: z.boolean(),
  llmError: z.string().optional(),
});
export type VisualDiffPage = z.infer<typeof VisualDiffPage>;

export const VisualDiffSummary = z.object({
  results: z.array(VisualDiffPage),
  pagesChecked: z.number(),
  pagesWithDiffs: z.number(),
  pagesPassed: z.number(),
  pagesFailed: z.number(),
  llmCallsUsed: z.number(),
});
export type VisualDiffSummary = z.infer<typeof VisualDiffSummary>;

/** SEO check — structured result so the report can render a dedicated tab. */
export const SeoPageMeta = z.object({
  pageKey: z.string(),
  pageLabel: z.string(),
  prodTitle: z.string().nullable(),
  candTitle: z.string().nullable(),
  prodDescription: z.string().nullable(),
  candDescription: z.string().nullable(),
  prodCanonical: z.string().nullable(),
  candCanonical: z.string().nullable(),
  prodRobots: z.string().nullable(),
  candRobots: z.string().nullable(),
  prodXRobotsTag: z.string().nullable(),
  candXRobotsTag: z.string().nullable(),
  prodJsonLdTypes: z.array(z.string()),
  candJsonLdTypes: z.array(z.string()),
  /** Aggregated severity for this page (max of all its issues). null = no issues. */
  maxSeverity: Severity.nullable(),
  issueCount: z.number(),
});
export type SeoPageMeta = z.infer<typeof SeoPageMeta>;

export const SeoRobotsTxt = z.object({
  prodPresent: z.boolean(),
  candPresent: z.boolean(),
  prodSitemaps: z.array(z.string()),
  candSitemaps: z.array(z.string()),
  uaDiffCount: z.number(),
  raw: z
    .object({
      prod: z.string().nullable(),
      cand: z.string().nullable(),
    })
    .optional(),
});
export type SeoRobotsTxt = z.infer<typeof SeoRobotsTxt>;

export const SeoSitemap = z.object({
  prodPresent: z.boolean(),
  candPresent: z.boolean(),
  prodCount: z.number(),
  candCount: z.number(),
  countDelta: z.number(),
  countPct: z.number(),
  onlyProdSample: z.array(z.string()),
  onlyCandSample: z.array(z.string()),
});
export type SeoSitemap = z.infer<typeof SeoSitemap>;

export const SeoSummary = z.object({
  pages: z.array(SeoPageMeta),
  robotsTxt: SeoRobotsTxt,
  sitemap: SeoSitemap,
  /** Issues raised by the SEO check (mirror of CheckResult.issues, kept here for self-contained tab rendering). */
  issues: z.array(Issue),
  /** Count of pages with at least one SEO regression. */
  pagesWithIssues: z.number(),
});
export type SeoSummary = z.infer<typeof SeoSummary>;

export const Verdict = z.object({
  status: z.enum(["pass", "warn", "fail"]),
  score: z.number().min(0).max(100),
  critical: z.number(),
  high: z.number(),
  medium: z.number(),
  low: z.number(),
  checksRun: z.number(),
  checksPassed: z.number(),
  checksFailed: z.number(),
  checksSkipped: z.number(),
});
export type Verdict = z.infer<typeof Verdict>;

export const Run = z.object({
  schemaVersion: z.literal("0.1"),
  id: z.string(),
  timestamp: z.string(),
  prodUrl: z.string(),
  candUrl: z.string(),
  flows: z.array(FlowName),
  viewports: z.array(Viewport),
  cep: z.string(),
  durationMs: z.number(),
  verdict: Verdict,
  topIssues: z.array(Issue),
  issues: z.array(Issue),
  checks: z.array(CheckResult),
  flowCaptures: z.array(FlowCapture),
  visualDiff: VisualDiffSummary.optional(),
  seo: SeoSummary.optional(),
  baseline: z
    .object({
      name: z.string(),
      delta: z.object({
        resolved: z.array(Issue),
        new: z.array(Issue),
        regressions: z.array(Issue),
      }),
    })
    .optional(),
});
export type Run = z.infer<typeof Run>;

export const Baseline = z.object({
  name: z.string(),
  createdAt: z.string(),
  fromRunId: z.string(),
  prodUrl: z.string(),
  candUrl: z.string(),
  verdict: Verdict,
  issues: z.array(Issue),
});
export type Baseline = z.infer<typeof Baseline>;

export const ParityRc = z.object({
  cep: z.string().default("01310-100"),
  plpUrlHint: z.string().optional(),
  selectors: z
    .object({
      categoryLink: z.string().optional(),
      productCard: z.string().optional(),
      buyButton: z.string().optional(),
      minicartTrigger: z.string().optional(),
      cepInputPdp: z.string().optional(),
      cepInputCart: z.string().optional(),
      checkoutButton: z.string().optional(),
    })
    .default({}),
  skipSteps: z.array(z.string()).default([]),
});
export type ParityRc = z.infer<typeof ParityRc>;

export const ParityIgnore = z.object({
  ignoreSelectorsVisual: z.array(z.string()).default([]),
  ignoreRequestPatterns: z.array(z.string()).default([]),
  ignoreConsolePatterns: z.array(z.string()).default([]),
  ignoreMetaKeys: z.array(z.string()).default([]),
  toleratedDomDrift: z.record(z.number()).default({}),
});
export type ParityIgnore = z.infer<typeof ParityIgnore>;
