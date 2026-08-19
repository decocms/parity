/**
 * Shared LLM call types. Pulled out of `client.ts` so providers can import
 * without a circular dep (client.ts → provider → client.ts).
 */

import type { Feature } from "./models.ts";

export interface ImageInput {
  base64: string;
  mediaType?: "image/png" | "image/jpeg" | "image/webp";
}

export interface ToolCallParams {
  feature: Feature;
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

export interface MessageCallParams {
  feature: Feature;
  systemPrompt: string;
  userText: string;
  maxTokens?: number;
  /** Hard timeout in ms. Default: 60s. */
  timeoutMs?: number;
}
