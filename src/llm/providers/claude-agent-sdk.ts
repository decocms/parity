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
 * Vision: when `userImages` is set, we switch from the plain-string `prompt`
 * form to the async-iterable `SDKUserMessage` form so the SDK can pass real
 * image blocks (base64) to the model — the same shape the direct Anthropic
 * SDK uses (`MessageParam` from `@anthropic-ai/sdk/resources`). Without this,
 * vision features (`visual-diff`, `section-understanding`) would silently
 * produce garbage because data-URL strings in `prompt` text are NOT parsed
 * as image inputs by the SDK.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tryRepairJson } from "../client.ts";
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

interface SdkQueryParams {
  prompt: string | AsyncIterable<{ type: "user"; message: unknown; parent_tool_use_id: null }>;
  options?: Record<string, unknown>;
}

interface SdkModule {
  query: (params: SdkQueryParams) => AsyncIterable<unknown>;
}

/** Lazy-load the SDK so installs without the optional dep still run. */
async function loadSdk(): Promise<SdkModule | null> {
  try {
    const mod = (await import("@anthropic-ai/claude-agent-sdk")) as SdkModule;
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
  subtype: string; // "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | ...
  is_error: boolean;
}

function isResultMessage(m: unknown): m is SdkResultSuccess | SdkResultError {
  return typeof m === "object" && m !== null && (m as { type?: string }).type === "result";
}

/**
 * Construct an abort controller paired with a timer that aborts after `ms`.
 * Returns the controller plus a `clear()` callback the caller MUST invoke in
 * a `finally` block — otherwise the timer leaks (and pins an unref'd handle
 * in the event loop).
 */
function makeAbortHandle(ms: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`SDK call timed out after ${ms}ms`)), ms);
  return { controller, clear: () => clearTimeout(timer) };
}

/**
 * Shared SDK options for plain LLM calls. We:
 *   - disable all tools (`allowedTools: []` is an exact whitelist; combined
 *     with `maxTurns: 1` this guarantees a single API round-trip)
 *   - skip filesystem context (`settingSources: []`) so we don't auto-load
 *     the user's CLAUDE.md / skills / agents into the prompt
 *   - silence the permission UI (`permissionMode: 'dontAsk'`)
 */
function baseSdkOptions(model: string, controller: AbortController): Record<string, unknown> {
  return {
    model,
    allowedTools: [],
    permissionMode: "dontAsk",
    maxTurns: 1,
    abortController: controller,
    settingSources: [],
  };
}

/**
 * Build a text-only prompt string (when no images are present).
 */
function buildTextPrompt(systemPrompt: string, userText: string): string {
  return `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userText}`;
}

/**
 * Build an async-iterable prompt yielding one user message with image blocks.
 * Shape mirrors `MessageParam.content` from `@anthropic-ai/sdk/resources` —
 * the SDK passes the message through to the Anthropic API verbatim.
 */
async function* buildImagePrompt(
  systemPrompt: string,
  userText: string,
  images: ImageInput[],
): AsyncIterable<{ type: "user"; message: unknown; parent_tool_use_id: null }> {
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: `SYSTEM:\n${systemPrompt}\n\nUSER:\n${userText}` },
  ];
  for (const img of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType ?? "image/png",
        data: img.base64,
      },
    });
  }
  yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

/**
 * Drain the SDK's async iterator until a `result` message arrives. We only
 * care about the terminal message; intermediate `assistant`/`status` messages
 * are ignored since `maxTurns: 1` means there's only one round-trip.
 */
async function awaitResult(iter: AsyncIterable<unknown>): Promise<SdkResultSuccess | SdkResultError | null> {
  for await (const msg of iter) {
    if (isResultMessage(msg)) return msg;
  }
  return null;
}

export async function callToolSdk<T>(
  params: ToolCallParams & { model: string; timeoutMs: number },
): Promise<T | null> {
  const sdk = await loadSdk();
  if (!sdk) return null;
  const { controller, clear } = makeAbortHandle(params.timeoutMs);
  try {
    const opts = baseSdkOptions(params.model, controller);
    // Ask for structured output matching the tool's input schema. The SDK
    // surfaces the parsed object on the success message as `structured_output`.
    opts.outputFormat = { type: "json_schema", schema: params.tool.inputSchema };
    const queryParams: SdkQueryParams =
      params.userImages?.length
        ? { prompt: buildImagePrompt(params.systemPrompt, params.userText, params.userImages), options: opts }
        : { prompt: buildTextPrompt(params.systemPrompt, params.userText), options: opts };
    const result = await awaitResult(sdk.query(queryParams));
    if (!result) return null;
    if (result.subtype !== "success" || result.is_error) {
      console.error(`[llm-claude-sdk] call failed: ${result.subtype}`);
      return null;
    }
    const success = result as SdkResultSuccess;
    if (success.structured_output && typeof success.structured_output === "object") {
      return success.structured_output as T;
    }
    // Some models bypass structured_output and emit the JSON in `result` —
    // attempt a parse, with the same fence/brace repair the OpenRouter
    // provider uses.
    const text = success.result;
    if (typeof text === "string") {
      try {
        return JSON.parse(text) as T;
      } catch {
        const repaired = tryRepairJson(text);
        if (repaired) {
          try {
            return JSON.parse(repaired) as T;
          } catch {
            /* fall through */
          }
        }
        console.error(
          `[llm-claude-sdk] no structured_output and result is not parseable JSON (head=${text.slice(0, 80)})`,
        );
      }
    }
    return null;
  } catch (err) {
    console.error(`[llm-claude-sdk] failed: ${(err as Error).message}`);
    return null;
  } finally {
    clear();
  }
}

export async function callMessageSdk(
  params: MessageCallParams & { model: string; timeoutMs: number },
): Promise<string | null> {
  const sdk = await loadSdk();
  if (!sdk) return null;
  const { controller, clear } = makeAbortHandle(params.timeoutMs);
  try {
    const opts = baseSdkOptions(params.model, controller);
    const result = await awaitResult(
      sdk.query({ prompt: buildTextPrompt(params.systemPrompt, params.userText), options: opts }),
    );
    if (!result) return null;
    if (result.subtype !== "success" || result.is_error) {
      console.error(`[llm-claude-sdk] message call failed: ${result.subtype}`);
      return null;
    }
    return (result as SdkResultSuccess).result ?? null;
  } catch (err) {
    console.error(`[llm-claude-sdk] failed: ${(err as Error).message}`);
    return null;
  } finally {
    clear();
  }
}
