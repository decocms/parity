/**
 * Global test setup. We force the Claude Agent SDK provider to report
 * unavailable so tests don't accidentally try to invoke the real `claude`
 * CLI on a developer machine that happens to have `~/.claude/`. Tests that
 * specifically exercise the SDK provider can unmock locally.
 */
import { vi } from "vitest";

vi.mock("../src/llm/providers/claude-agent-sdk.ts", () => ({
  isClaudeAgentSdkAvailable: () => false,
  callToolSdk: vi.fn(async () => null),
  callMessageSdk: vi.fn(async () => null),
}));
