import Anthropic from "@anthropic-ai/sdk";

/** Default Claude model identifier when calling via Anthropic SDK directly. */
export const LLM_MODEL_ANTHROPIC = "claude-sonnet-4-6";
/** Default OpenRouter model identifier (override via env PARITY_OPENROUTER_MODEL). */
export const LLM_MODEL_OPENROUTER = process.env.PARITY_OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5";

export type Provider = "anthropic" | "openrouter";

export function getProvider(): Provider | null {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  return null;
}

export function isLlmAvailable(): boolean {
  return getProvider() !== null;
}

export function providerLabel(): string {
  const p = getProvider();
  if (p === "anthropic") return `Anthropic (${LLM_MODEL_ANTHROPIC})`;
  if (p === "openrouter") return `OpenRouter (${LLM_MODEL_OPENROUTER})`;
  return "none";
}

export interface ImageInput {
  base64: string;
  mediaType?: "image/png" | "image/jpeg" | "image/webp";
}

export interface ToolCallParams {
  systemPrompt: string;
  userText: string;
  userImages?: ImageInput[];
  tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  maxTokens?: number;
  /** Hard timeout in ms. Default: 120s for image calls, 60s for text-only. */
  timeoutMs?: number;
}

/** Default timeout for LLM calls. Vision (with images) gets more time. */
function defaultTimeout(params: { userImages?: unknown[] }): number {
  return params.userImages && params.userImages.length > 0 ? 120_000 : 60_000;
}

function makeTimeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(new Error(`LLM call timed out after ${ms}ms`)), ms);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
}

/**
 * Unified tool-call interface across Anthropic SDK and OpenRouter.
 * Returns the parsed tool input object, or null if no provider is configured
 * or the call failed.
 */
export async function callTool<T = Record<string, unknown>>(
  params: ToolCallParams,
): Promise<T | null> {
  const provider = getProvider();
  if (provider === "anthropic") return callAnthropicTool<T>(params);
  if (provider === "openrouter") return callOpenRouterTool<T>(params);
  return null;
}

async function callAnthropicTool<T>(params: ToolCallParams): Promise<T | null> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  const userContent: Anthropic.ContentBlockParam[] = [{ type: "text", text: params.userText }];
  for (const img of params.userImages ?? []) {
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType ?? "image/png",
        data: img.base64,
      },
    });
  }
  const timeoutMs = params.timeoutMs ?? defaultTimeout(params);
  const { signal, clear } = makeTimeoutSignal(timeoutMs);
  try {
    const response = await client.messages.create(
      {
        model: LLM_MODEL_ANTHROPIC,
        max_tokens: params.maxTokens ?? 2000,
        system: [
          { type: "text", text: params.systemPrompt, cache_control: { type: "ephemeral" } },
        ],
        tools: [
          {
            name: params.tool.name,
            description: params.tool.description,
            input_schema: params.tool.inputSchema as Anthropic.Tool["input_schema"],
          },
        ],
        tool_choice: { type: "tool", name: params.tool.name },
        messages: [{ role: "user", content: userContent }],
      },
      { signal },
    );
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === params.tool.name) {
        return block.input as T;
      }
    }
  } catch (err) {
    console.error(`[llm-anthropic] failed: ${(err as Error).message}`);
  } finally {
    clear();
  }
  return null;
}

interface OpenAiContentBlock {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

async function callOpenRouterTool<T>(params: ToolCallParams): Promise<T | null> {
  // Retry transient failures (5xx, 429, network aborts, or truncated tool
  // arguments that `tryRepairJson` can't salvage). The second attempt
  // doubles `maxTokens` so the model has enough room to complete its
  // tool call; the most common parse failure mode is mid-object
  // truncation when the response hits the cap.
  const baseTokens = params.maxTokens ?? 2000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const isRetry = attempt > 1;
    const tokens = isRetry ? Math.max(baseTokens * 2, 4000) : baseTokens;
    const result = await openRouterToolOnce<T>(params, tokens, isRetry);
    if (result !== undefined) return result;
  }
  return null;
}

/**
 * Single attempt against OpenRouter. Returns:
 *   - T          → parsed successfully
 *   - null       → permanent failure (auth, schema, non-retryable 4xx)
 *   - undefined  → transient failure, caller may retry
 */
async function openRouterToolOnce<T>(
  params: ToolCallParams,
  maxTokens: number,
  isRetry: boolean,
): Promise<T | null | undefined> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const userContent: OpenAiContentBlock[] = [{ type: "text", text: params.userText }];
  for (const img of params.userImages ?? []) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:${img.mediaType ?? "image/png"};base64,${img.base64}`,
      },
    });
  }

  const timeoutMs = params.timeoutMs ?? defaultTimeout(params);
  const { signal, clear } = makeTimeoutSignal(timeoutMs);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/decocms/parity",
        "X-Title": "parity CLI",
      },
      body: JSON.stringify({
        model: LLM_MODEL_OPENROUTER,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: userContent },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: params.tool.name,
              description: params.tool.description,
              parameters: params.tool.inputSchema,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: params.tool.name } },
      }),
    });
    if (!response.ok) {
      const txt = await response.text().catch(() => "");
      console.error(`[llm-openrouter] HTTP ${response.status}: ${txt.slice(0, 200)}`);
      // 5xx and 429 are transient; everything else (auth, schema) is permanent.
      if (response.status >= 500 || response.status === 429) return undefined;
      return null;
    }
    const json = (await response.json()) as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{
            function?: { name: string; arguments: string };
          }>;
          content?: string | null;
        };
      }>;
    };
    const toolCall = json.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.name === params.tool.name) {
      const raw = toolCall.function.arguments ?? "";
      try {
        return JSON.parse(raw) as T;
      } catch {
        // Some models truncate or emit slightly malformed JSON when the
        // schema is large or `maxTokens` clips the response mid-object.
        // Try a couple of cheap recovery passes before giving up:
        //   1. close any obvious dangling brace/bracket
        //   2. unwrap a ```json``` fence the model snuck in
        const repaired = tryRepairJson(raw);
        if (repaired) {
          try {
            return JSON.parse(repaired) as T;
          } catch {
            /* fall through */
          }
        }
        if (isRetry) {
          console.error(
            `[llm-openrouter] failed to parse tool arguments after retry (raw len=${raw.length}, head=${JSON.stringify(raw.slice(0, 80))})`,
          );
          return null;
        }
        console.error(
          `[llm-openrouter] parse error, retrying with more tokens (raw len=${raw.length}, head=${JSON.stringify(raw.slice(0, 80))})`,
        );
        return undefined; // signal retry
      }
    }
    // Some models return tool intent inside content as JSON when tool_choice is enforced loosely
    const content = json.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim().startsWith("{")) {
      try {
        return JSON.parse(content) as T;
      } catch {
        /* not parseable, fall through */
      }
    }
    return null;
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[llm-openrouter] failed: ${msg}`);
    // Network errors / aborts are worth a retry.
    if (!isRetry && (msg.includes("ECONN") || msg.includes("aborted") || msg.includes("fetch"))) {
      return undefined;
    }
    return null;
  } finally {
    clear();
  }
}

/**
 * Best-effort JSON repair for slightly malformed tool-call arguments
 * returned by some OpenRouter-backed models (truncated responses,
 * ```json``` fences, missing closing braces). Returns null if it can't
 * produce something parseable in a couple of cheap passes.
 */
function tryRepairJson(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  // Unwrap ```json ... ``` fences.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fence?.[1]) s = fence[1].trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return null;
  // Balance braces/brackets: count opens, append matching closers.
  let depthObj = 0;
  let depthArr = 0;
  let inString = false;
  let isEscaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (ch === "\\") {
      isEscaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depthObj++;
    else if (ch === "}") depthObj--;
    else if (ch === "[") depthArr++;
    else if (ch === "]") depthArr--;
  }
  if (inString) s += '"';
  while (depthArr > 0) {
    s += "]";
    depthArr--;
  }
  while (depthObj > 0) {
    s += "}";
    depthObj--;
  }
  return s;
}

export interface MessageCallParams {
  systemPrompt: string;
  userText: string;
  maxTokens?: number;
  /** Hard timeout in ms. Default: 60s. */
  timeoutMs?: number;
}

/**
 * Free-form text response (no tool-use). Used by `parity explain`.
 */
export async function callMessage(params: MessageCallParams): Promise<string | null> {
  const provider = getProvider();
  if (provider === "anthropic") return callAnthropicMessage(params);
  if (provider === "openrouter") return callOpenRouterMessage(params);
  return null;
}

async function callAnthropicMessage(params: MessageCallParams): Promise<string | null> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  const { signal, clear } = makeTimeoutSignal(params.timeoutMs ?? 60_000);
  try {
    const response = await client.messages.create(
      {
        model: LLM_MODEL_ANTHROPIC,
        max_tokens: params.maxTokens ?? 1500,
        system: [
          { type: "text", text: params.systemPrompt, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: params.userText }],
      },
      { signal },
    );
    const parts: string[] = [];
    for (const block of response.content) {
      if (block.type === "text") parts.push(block.text);
    }
    return parts.join("\n");
  } catch (err) {
    console.error(`[llm-anthropic] failed: ${(err as Error).message}`);
    return null;
  } finally {
    clear();
  }
}

async function callOpenRouterMessage(params: MessageCallParams): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const { signal, clear } = makeTimeoutSignal(params.timeoutMs ?? 60_000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/decocms/parity",
        "X-Title": "parity CLI",
      },
      body: JSON.stringify({
        model: LLM_MODEL_OPENROUTER,
        max_tokens: params.maxTokens ?? 1500,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userText },
        ],
      }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clear();
  }
}

