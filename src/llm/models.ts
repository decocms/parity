/**
 * Per-feature model routing. Each LLM call site declares its `feature`, and
 * we map to a model tier (haiku / sonnet / opus). Tiers map to provider-specific
 * model IDs. Users can override per-feature or globally via CLI flags.
 *
 * The default map biases toward the cheapest model that still does the job:
 * selector discovery and step recovery need fast small calls; visual diff and
 * aggregation need sonnet-class reasoning; explain needs opus-class depth.
 */

export type Feature =
  | "selector-discovery"
  | "step-recovery"
  | "search-terms"
  | "plp-matching"
  | "pdp-matching"
  | "section-understanding"
  | "visual-diff"
  | "issue-aggregation"
  | "explain";

export const ALL_FEATURES: readonly Feature[] = [
  "selector-discovery",
  "step-recovery",
  "search-terms",
  "plp-matching",
  "pdp-matching",
  "section-understanding",
  "visual-diff",
  "issue-aggregation",
  "explain",
];

export type ModelTier = "haiku" | "sonnet" | "opus";

export type Provider = "anthropic" | "openrouter" | "claude-agent-sdk";

/**
 * Default tier per feature. Selector-related features (discovery, recovery,
 * PLP/PDP matching) default to Sonnet because Haiku regressed real
 * purchase-journey runs against bagaggio in 0.11.x: Haiku-discovered
 * selectors didn't match the PLP markup and Haiku step-recovery couldn't
 * find a product card either, causing the journey to skip enter-pdp and
 * everything downstream. Lighter calls (search-terms) stay on Haiku.
 * Issue #102 (regression from #66).
 *
 * Want the old Haiku-everywhere behavior to save cost? Use
 * `--llm-tier-default haiku` to flip everything in one shot.
 */
export const DEFAULT_FEATURE_TIER: Record<Feature, ModelTier> = {
  "selector-discovery": "sonnet",
  "step-recovery": "sonnet",
  "search-terms": "haiku",
  "plp-matching": "sonnet",
  "pdp-matching": "sonnet",
  "section-understanding": "sonnet",
  "visual-diff": "sonnet",
  "issue-aggregation": "sonnet",
  explain: "opus",
};

/**
 * Provider-specific model identifiers per tier. The OpenRouter slugs follow
 * the `anthropic/<family>-<version>` convention. Update when new model
 * generations ship — these are pinned intentionally so behavior is stable.
 */
export const PROVIDER_MODELS: Record<Provider, Record<ModelTier, string>> = {
  anthropic: {
    haiku: "claude-haiku-4-5",
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-7",
  },
  openrouter: {
    haiku: process.env.PARITY_OPENROUTER_MODEL_HAIKU ?? "anthropic/claude-haiku-4.5",
    sonnet: process.env.PARITY_OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5",
    opus: process.env.PARITY_OPENROUTER_MODEL_OPUS ?? "anthropic/claude-opus-4.7",
  },
  "claude-agent-sdk": {
    haiku: "claude-haiku-4-5",
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-7",
  },
};

// Mutable overrides applied via CLI flags. Mutated once at startup, read on each call.
const featureOverrides: Partial<Record<Feature, string>> = {};
let defaultTierOverride: ModelTier | null = null;
let defaultModelOverride: string | null = null;

/**
 * Apply CLI flag overrides. Call once at startup. Pass `null`/undefined to clear.
 * - `perFeature`: `{ "visual-diff": "opus-4-7" }` → exact model ID override for that feature
 * - `defaultTier`: bumps the default tier for every feature that doesn't have a per-feature override
 * - `defaultModel`: forces every feature to use this exact model ID (highest precedence)
 */
export function applyModelOverrides(opts: {
  perFeature?: Partial<Record<Feature, string>>;
  defaultTier?: ModelTier | null;
  defaultModel?: string | null;
}): void {
  if (opts.perFeature) {
    for (const k of Object.keys(opts.perFeature) as Feature[]) {
      const v = opts.perFeature[k];
      if (v) featureOverrides[k] = v;
    }
  }
  if (opts.defaultTier !== undefined) defaultTierOverride = opts.defaultTier;
  if (opts.defaultModel !== undefined) defaultModelOverride = opts.defaultModel;
}

export function resetModelOverrides(): void {
  for (const k of Object.keys(featureOverrides) as Feature[]) delete featureOverrides[k];
  defaultTierOverride = null;
  defaultModelOverride = null;
}

/**
 * Resolve the model ID for a feature/provider pair. Precedence:
 *   1. `--llm-model-default <model>` (defaultModelOverride) — wins everything
 *   2. `--llm-model <feat>=<model>` (featureOverrides[feature])
 *   3. `--llm-tier-default <tier>` (defaultTierOverride) + provider map
 *   4. DEFAULT_FEATURE_TIER[feature] + provider map
 */
export function resolveModel(feature: Feature, provider: Provider): string {
  if (defaultModelOverride) return defaultModelOverride;
  const perFeature = featureOverrides[feature];
  if (perFeature) return perFeature;
  const tier = defaultTierOverride ?? DEFAULT_FEATURE_TIER[feature];
  return PROVIDER_MODELS[provider][tier];
}

/**
 * Parse a `<feature>=<model>,<feature>=<model>` CLI string into the override map.
 * Unknown feature keys are reported in the returned `errors` array and skipped.
 */
export function parseFeatureOverrides(spec: string): {
  overrides: Partial<Record<Feature, string>>;
  errors: string[];
} {
  const overrides: Partial<Record<Feature, string>> = {};
  const errors: string[] = [];
  const known = new Set<string>(ALL_FEATURES);
  for (const pair of spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      errors.push(`malformed override "${pair}" (expected feature=model)`);
      continue;
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!known.has(key)) {
      errors.push(`unknown feature "${key}" (valid: ${ALL_FEATURES.join(", ")})`);
      continue;
    }
    if (!value) {
      errors.push(`empty model for feature "${key}"`);
      continue;
    }
    overrides[key as Feature] = value;
  }
  return { overrides, errors };
}

/** Snapshot the resolved model per feature for the active provider — used for the startup banner. */
export function snapshotResolved(provider: Provider): Record<Feature, string> {
  const out = {} as Record<Feature, string>;
  for (const f of ALL_FEATURES) out[f] = resolveModel(f, provider);
  return out;
}
