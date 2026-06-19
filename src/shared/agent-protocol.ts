export type AgentRole = "system" | "user" | "assistant" | "tool";

export type AgentMessageContentKind = "context_summary";

export type ContextSummaryMetadata = {
  coveredMessageCount?: number;
  coveredUntilMessageId?: string;
};

export type ModelToolCall = {
  arguments: string;
  id: string;
  name: string;
};

export type AgentMessage = {
  id: string;
  role: AgentRole;
  content: string;
  contentKind?: AgentMessageContentKind;
  contextSummary?: ContextSummaryMetadata;
  toolCallId?: string | null;
  toolCalls?: ModelToolCall[];
  toolName?: string | null;
  createdAt: string;
};

export type PermissionMode =
  | "read-only"
  | "ask-on-write"
  | "auto-safe"
  | "plan"
  | "bypass";

export type RunStatus =
  | "queued"
  | "preparing"
  | "streaming_model"
  | "waiting_approval"
  | "executing_tools"
  | "compacting"
  | "finalizing"
  | "completed"
  | "failed"
  | "aborted"
  | "expired";

export type ToolRisk = "read" | "write" | "external" | "destructive";

export type ToolApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type RunQueueMode = "followup" | "interrupt" | "steer" | "collect";

export type ToolUiManifest = {
  description?: string;
  displayName: string;
  isReadOnly: boolean;
  name: string;
  requiresApproval: boolean;
  risk: ToolRisk;
};

export type AgentEvent =
  | { type: "run.accepted"; queueMode?: RunQueueMode; runId: string; sessionId: string }
  | { type: "run.started"; runId: string }
  | { type: "context.built"; snapshotId: string; tokenEstimate: number }
  | { type: "system.reminder.persisted"; messageId: string; runId: string; sanitized: boolean }
  | {
      type: "context.compaction.started";
      beforeTokenEstimate: number;
      reason: "proactive" | "reactive";
    }
  | {
      type: "context.compacted";
      afterTokenEstimate: number;
      beforeTokenEstimate: number;
      compactedMessageCount: number;
      reason?: "proactive" | "reactive";
      summaryMessageId: string;
    }
  | {
      type: "payload.sanitized";
      insertedMissingToolResults: number;
      invalidToolArguments: number;
      removedOrphanToolResults: number;
      runId: string;
    }
  | {
      type: "protocol.recovery";
      reason: "visible_tool_call" | "duplicate_answer_prefix" | "context_too_long";
      retryAttempt: number;
      runId: string;
      toolName?: string;
    }
  | { type: "assistant.delta"; messageId: string; text: string }
  | { type: "assistant.delta.retracted"; messageId: string; text: string }
  | { type: "reasoning.delta"; messageId: string; text: string }
  | {
      type: "tool.started";
      argumentsPreview?: string;
      runId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool.approval.required";
      approvalId: string;
      reason: string;
      runId: string;
      toolCallId: string;
      toolName: string;
      risk: ToolRisk;
    }
  | {
      type: "tool.confirmation.required";
      confirmationId: string;
      message: string;
      runId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool.approval.resolved";
      approvalId: string;
      approved: boolean;
      runId: string;
      status: ToolApprovalStatus;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool.completed";
      durationMs?: number;
      resultPreview?: string;
      runId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool.failed";
      durationMs?: number;
      error: string;
      runId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "usage.updated";
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      costUsd?: number;
    }
  | { type: "run.completed"; runId: string; finalMessageId: string }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.aborted"; runId: string; reason: string };

export type SequencedAgentEvent = AgentEvent & {
  seq: number;
};

export type AgentRunRequest = {
  sessionId?: string | null;
  agentId?: string;
  message: string;
  model?: string;
  permissionMode?: PermissionMode;
  queueMode?: RunQueueMode;
  thinking?: "enabled" | "disabled";
  maxTokens?: number;
};

export type ContextSnapshot = {
  id: string;
  messages: ModelMessage[];
  promptSections: Array<{
    content: string;
    source: string;
    status?: string;
    tag: string;
    tier: "stable" | "context" | "volatile";
  }>;
  promptTiers: Record<"stable" | "context" | "volatile", string>;
  tokenEstimate: number;
};

export type ModelToolDefinition = {
  function: {
    description: string;
    name: string;
    parameters: Record<string, unknown>;
  };
  type: "function";
};

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: ModelToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };
