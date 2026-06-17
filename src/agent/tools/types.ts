import type { ModelToolCall, ModelToolDefinition } from "@/agent/runtime/types";
import type { SessionRepository } from "@/agent/sessions/SessionRepository";

export type ToolExecutionContext = {
  runId: string;
  sessionId: string;
  sessions: SessionRepository;
  userId: string;
};

export type AgentTool = {
  definition: ModelToolDefinition;
  execute(args: unknown, context: ToolExecutionContext, toolCall: ModelToolCall): Promise<string>;
  name: string;
};

export function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Tool arguments are not valid JSON: ${message}`);
  }
}

export function toolError(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ success: false, error: message, ...extra });
}

export function toolSuccess(payload: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...payload });
}
