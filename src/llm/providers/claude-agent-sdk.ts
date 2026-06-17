/**
 * Claude Agent SDK provider — reuses the user's local `claude` CLI auth
 * (same path Conductor uses to spawn subagents). Billed to the user's Claude
 * plan, no API key needed.
 *
 * Tradeoffs vs the direct `anthropic` provider:
 *   - higher latency (spawns the `claude` binary per call)
 *   - costs go to the user's Claude plan, not API billing
 *   - works without setting any env var
 *
 * The SDK supports `outputFormat: { type: 'json_schema', schema }` which gives
 * us back a `structured_output` field — that's how we implement `callTool`
 * without falling back to free-form parsing.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImageInput, ToolCallParams, MessageCallParams } from "../types.ts";

/**
 * Cheap synchronous check — does `~/.claude/` exist? If yes, the user has logged
 * into Claude Code at least once and the SDK can attempt to use those credentials.
 * Actual auth validity is checked on the first real call.
 */
export function isClaudeAgentSdkAvailable(): boolean {
  const dir = join(homedir(), ".claude");
  return existsSync(dir);
}

/** Lazy-load the SDK so installs without the optional dep still run. */
async function loadSdk(): Promise<{
  query: (params: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown>;
} | null> {
  try {
    const mod = (await import("@anthropic-ai/claude-agent-sdk")) as {
      query: (params: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown>;
    };
    return { query: mod.query };
  } catch (err) {
    console.error(`[llm-claude-sdk] failed to load @anthropic-ai/claude-agent-sdk: ${(err as Error).message}`);
    return null;
  }
}

interface SdkResultSuccess {
  type: "result";
  subtype: "success";
  result: string;
  structured_output?: unknown;
  is_error: boolean;
}

interface SdkResultError {
  type: "result";
  subtype: "error_max_turns" | "error_during_execution" | string;
  is_error: boolean;
}

function isResultMessage(m: unknown): m is SdkResultSuccess | SdkResultError {
  return typeof m === "object" && m !== null && (m as { type?: string }).type === "result";
}

/**
 * Build a single self-contained prompt string for the SDK. The SDK takes a
 * single user-facing prompt and optional system prompt via settings; we just
 * concatenate system + user with a clear separator since we don't want the
 * SDK to pull in the user's CLAUDE.md or default tools.
 */
function buildPrompt(systemPrompt: string, userText: string, userImages: ImageInput[] | undefined): string {
  const parts: string[] = [];
  parts.push("SYSTEM:");
  parts.push(systemPrompt);
  parts.push("");
  parts.push("USER:");
  parts.push(userText);
  if (userImages?.length) {
    parts.push("");
    parts.push(`[${userImages.length} image(s) attached as base64 below]`);
    for (let i = 0; i < userImages.length; i++) {
      const img = userImages[i]!;
      parts.push(`--- image ${i + 1} (${img.mediaType ?? "image/png"}) ---`);
      parts.push(`data:${img.mediaType ?? "image/png"};base64,${img.base64}`);
    }
  }
  return parts.join("\n");
}

/**
 * Common SDK options we pass on every call. We disable tools and skip all
 * filesystem context — this is a plain LLM call, not an agent loop.
 */
function baseSdkOptions(model: string, timeoutMs: number): Record<string, unknown> {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`SDK call timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    model,
    allowedTools: [],
    disallowedTools: ["*"],
    permissionMode: "dontAsk",
    maxTurns: 1,
    abortController: controller,
    // Don't auto-load CLAUDE.md or skills; we want a clean single-shot call
    settingSources: [],
  };
}

export async function callToolSdk<T>(
  params: ToolCallParams & { model: string; timeoutMs: number },
): Promise<T | null> {
  const sdk = await loadSdk();
  if (!sdk) return null;
  const opts = baseSdkOptions(params.model, params.timeoutMs);
  // Ask for structured output matching the tool's input schema. The SDK will
  // surface the parsed object on the success message as `structured_output`.
  opts.outputFormat = { type: "json_schema", schema: params.tool.inputSchema };
  const prompt = buildPrompt(params.systemPrompt, params.userText, params.userImages);
  try {
    for await (const msg of sdk.query({ prompt, options: opts })) {
      if (!isResultMessage(msg)) continue;
      if (msg.subtype === "success" && !msg.is_error) {
        const structured = (msg as SdkResultSuccess).structured_output;
        if (structured && typeof structured === "object") return structured as T;
        // Some models return the JSON in `result` instead of structured_output
        const text = (msg as SdkResultSuccess).result;
        if (typeof text === "string") {
          try {
            return JSON.parse(text) as T;
          } catch {
            console.error(`[llm-claude-sdk] no structured_output and result is not JSON (head=${text.slice(0, 80)})`);
            return null;
          }
        }
        return null;
      }
      console.error(`[llm-claude-sdk] call failed: ${msg.subtype}`);
      return null;
    }
  } catch (err) {
    console.error(`[llm-claude-sdk] failed: ${(err as Error).message}`);
  }
  return null;
}

export async function callMessageSdk(
  params: MessageCallParams & { model: string; timeoutMs: number },
): Promise<string | null> {
  const sdk = await loadSdk();
  if (!sdk) return null;
  const opts = baseSdkOptions(params.model, params.timeoutMs);
  const prompt = buildPrompt(params.systemPrompt, params.userText, undefined);
  try {
    for await (const msg of sdk.query({ prompt, options: opts })) {
      if (!isResultMessage(msg)) continue;
      if (msg.subtype === "success" && !msg.is_error) {
        return (msg as SdkResultSuccess).result ?? null;
      }
      console.error(`[llm-claude-sdk] message call failed: ${msg.subtype}`);
      return null;
    }
  } catch (err) {
    console.error(`[llm-claude-sdk] failed: ${(err as Error).message}`);
  }
  return null;
}
