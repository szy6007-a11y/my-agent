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
  artifacts?: AgentArtifact[];
  contentKind?: AgentMessageContentKind;
  contextSummary?: ContextSummaryMetadata;
  toolCallId?: string | null;
  toolCalls?: ModelToolCall[];
  toolName?: string | null;
  createdAt: string;
};

export type ChatSessionSummary = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type SharedAgentSession = {
  token: string;
  createdAt: string;
  session: ChatSessionSummary;
  messages: AgentMessage[];
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

export type AgentTaskKind = "task" | "subagent";

export type AgentTaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type AgentTaskSummary = {
  id: string;
  kind: AgentTaskKind;
  status: AgentTaskStatus;
  subject: string;
  description: string;
  activeForm?: string | null;
  goal?: string;
  context?: string;
  role?: string;
  background?: boolean;
  toolsets?: string[];
  model?: string | null;
  parentSessionId?: string | null;
  parentRunId?: string | null;
  childSessionId?: string | null;
  childRunId?: string | null;
  resultPreview?: string | null;
  error?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
};

export type AskUserQuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type AskUserQuestion = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
};

export type AskUserQuestionAnnotation = {
  notes?: string;
  preview?: string;
};

export type AskUserQuestionRequest = {
  kind: "ask_user_question";
  questions: AskUserQuestion[];
  metadata?: Record<string, unknown>;
};

export type AskUserQuestionResponse = {
  answers: Record<string, string>;
  annotations?: Record<string, AskUserQuestionAnnotation>;
};

export type ToolUiManifest = {
  description?: string;
  displayName: string;
  isReadOnly: boolean;
  name: string;
  requiresApproval: boolean;
  risk: ToolRisk;
};

export type AgentArtifact = {
  contentType: string;
  downloadUrl: string;
  filename: string;
  id: string;
  path: string;
  sizeBytes: number;
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
      sessionId?: string;
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
      reason:
        | "visible_tool_call"
        | "missing_final_answer"
        | "duplicate_answer_prefix"
        | "context_too_long";
      retryAttempt: number;
      runId: string;
      toolName?: string;
    }
  | { type: "assistant.answer.started"; messageId: string; runId: string }
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
      request?: unknown;
      runId: string;
      toolCallId: string;
      toolName: string;
      risk: ToolRisk;
    }
  | {
      type: "tool.question.required";
      message: string;
      questionId: string;
      questions: AskUserQuestion[];
      request?: AskUserQuestionRequest;
      runId: string;
      toolCallId: string;
      toolName: string;
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
      type: "artifact.created";
      artifact: AgentArtifact;
      runId: string;
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "task.created";
      runId: string;
      task: AgentTaskSummary;
    }
  | {
      type: "task.updated";
      runId: string;
      task: AgentTaskSummary;
    }
  | {
      type: "task.completed";
      resultPreview?: string;
      runId: string;
      task: AgentTaskSummary;
    }
  | {
      type: "task.failed";
      error: string;
      runId: string;
      task: AgentTaskSummary;
    }
  | {
      type: "task.cancelled";
      reason?: string;
      runId: string;
      task: AgentTaskSummary;
    }
  | {
      type: "subagent.started";
      activity?: string;
      runId: string;
      task: AgentTaskSummary;
    }
  | {
      type: "subagent.progress";
      activity: string;
      runId: string;
      task: AgentTaskSummary;
    }
  | {
      type: "subagent.completed";
      resultPreview?: string;
      runId: string;
      task: AgentTaskSummary;
    }
  | {
      type: "subagent.failed";
      error: string;
      runId: string;
      task: AgentTaskSummary;
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
