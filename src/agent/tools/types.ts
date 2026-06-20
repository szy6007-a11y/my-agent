import type {
  ModelToolCall,
  ModelToolDefinition,
  PermissionMode,
  ToolRisk,
} from "@/agent/runtime/types";
import type {
  SessionRepository,
  StoredToolApproval,
} from "@/agent/sessions/SessionRepository";
import type { FileReadState } from "@/agent/tools/FileReadState";

export type ToolExecutionContext = {
  permissionMode?: PermissionMode;
  readFileState?: FileReadState;
  runId: string;
  signal?: AbortSignal;
  sessionId: string;
  sessions: SessionRepository;
  userId: string;
};

export type ToolValidationResult =
  | { ok: true }
  | { extra?: Record<string, unknown>; message: string; ok: false };

export type AgentTool = {
  applyApprovalDecision?: (
    args: unknown,
    approval: StoredToolApproval,
    context: ToolExecutionContext,
    toolCall: ModelToolCall,
  ) => Promise<unknown> | unknown;
  buildApproval?: (
    args: unknown,
    context: ToolExecutionContext,
    toolCall: ModelToolCall,
  ) => Promise<{ reason?: string; request?: Record<string, unknown> }> | { reason?: string; request?: Record<string, unknown> };
  definition: ModelToolDefinition;
  execute(args: unknown, context: ToolExecutionContext, toolCall: ModelToolCall): Promise<string>;
  isEnabled?: () => boolean;
  isReadOnly?: boolean;
  maxResultSizeChars?: number;
  name: string;
  requiresApproval?:
    | boolean
    | ((
        args: unknown,
        context: ToolExecutionContext,
        toolCall: ModelToolCall,
      ) => Promise<boolean> | boolean);
  requiresUserInteraction?: boolean;
  risk?: ToolRisk;
  validateInput?: (
    args: unknown,
    context: ToolExecutionContext,
    toolCall: ModelToolCall,
  ) => Promise<ToolValidationResult> | ToolValidationResult;
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

export function truncateToolResult(result: string, maxChars: number | undefined): string {
  if (!maxChars || result.length <= maxChars) {
    return result;
  }

  const suffix = "\n\n[tool result truncated by runtime]";
  return `${result.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}
