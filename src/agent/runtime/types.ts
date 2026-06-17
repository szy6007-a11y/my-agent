export type AgentRole = "system" | "user" | "assistant" | "tool";

export type AgentMessage = {
  id: string;
  role: AgentRole;
  content: string;
  toolCallId?: string | null;
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

export type AgentEvent =
  | { type: "run.accepted"; runId: string; sessionId: string }
  | { type: "run.started"; runId: string }
  | { type: "context.built"; snapshotId: string; tokenEstimate: number }
  | { type: "assistant.delta"; messageId: string; text: string }
  | { type: "reasoning.delta"; messageId: string; text: string }
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

export type AgentRunRequest = {
  sessionId?: string | null;
  agentId?: string;
  message: string;
  model?: string;
  permissionMode?: PermissionMode;
  thinking?: "enabled" | "disabled";
  maxTokens?: number;
};

export type ContextSnapshot = {
  id: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
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
