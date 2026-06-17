import type { ContextSnapshot } from "@/agent/runtime/types";

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; totalTokens?: number };

export type ModelStreamInput = {
  model: string;
  context: ContextSnapshot;
  maxTokens: number;
  runId: string;
  sessionId: string;
  thinking: "enabled" | "disabled";
  signal: AbortSignal;
  userId: string;
};

export interface ProviderAdapter {
  stream(input: ModelStreamInput): AsyncGenerator<ModelStreamEvent>;
}
