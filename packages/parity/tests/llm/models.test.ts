import { afterEach, describe, expect, it } from "vitest";
import {
  applyModelOverrides,
  DEFAULT_FEATURE_TIER,
  PROVIDER_MODELS,
  resetModelOverrides,
  resolveModel,
} from "../../src/llm/models.ts";

afterEach(() => resetModelOverrides());

describe("model tiers (#256)", () => {
  it("explain defaults to sonnet, not opus", () => {
    expect(DEFAULT_FEATURE_TIER.explain).toBe("sonnet");
    expect(resolveModel("explain", "anthropic")).toBe(PROVIDER_MODELS.anthropic.sonnet);
  });

  it("--llm-premium bumps reasoning-heavy features to opus, leaves mechanical ones cheap", () => {
    applyModelOverrides({ premium: true });
    expect(resolveModel("explain", "anthropic")).toBe(PROVIDER_MODELS.anthropic.opus);
    expect(resolveModel("issue-aggregation", "anthropic")).toBe(PROVIDER_MODELS.anthropic.opus);
    expect(resolveModel("visual-diff", "anthropic")).toBe(PROVIDER_MODELS.anthropic.opus);
    // mechanical features stay on their cheaper default
    expect(resolveModel("selector-discovery", "anthropic")).toBe(PROVIDER_MODELS.anthropic.sonnet);
    expect(resolveModel("search-terms", "anthropic")).toBe(PROVIDER_MODELS.anthropic.haiku);
  });

  it("explicit --llm-tier-default wins over premium", () => {
    applyModelOverrides({ premium: true, defaultTier: "haiku" });
    expect(resolveModel("explain", "anthropic")).toBe(PROVIDER_MODELS.anthropic.haiku);
  });

  it("resetModelOverrides clears premium", () => {
    applyModelOverrides({ premium: true });
    resetModelOverrides();
    expect(resolveModel("explain", "anthropic")).toBe(PROVIDER_MODELS.anthropic.sonnet);
  });
});
