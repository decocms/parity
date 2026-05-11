import Anthropic from "@anthropic-ai/sdk";

export const LLM_MODEL = "claude-sonnet-4-6";

export function getLlmClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

export function isLlmAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
