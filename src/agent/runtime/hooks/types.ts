import type {
  AgentMessage,
  ModelToolCall,
  PermissionMode,
  ToolRisk,
} from "@/agent/runtime/types";

export type HookEvent =
  | "pre_model_call"
  | "post_model_response"
  | "pre_tool_use"
  | "post_tool_use"
  | "pre_compact"
  | "post_compact"
  | "message_end";

export type PreModelCallContext = {
  iteration: number;
  lastUserMessage?: AgentMessage;
  messages: AgentMessage[];
  model: string;
  runId: string;
  sessionId: string;
  toolNames: string[];
  userId: string;
};

export type PreModelCallResult = {
  reminders?: string[];
  rewriteLastUserContent?: string;
};

export type PreModelCallRunResult = {
  lastUserContentRewritten: boolean;
  reminders: string[];
};

export type PostModelResponseContext = {
  content: string;
  iteration: number;
  runId: string;
  sessionId: string;
  toolCalls: ModelToolCall[];
  userId: string;
};

export type PostModelResponseResult = {
  deny?: {
    reason: string;
    userMessage?: string;
  };
};

export type PreToolUseContext = {
  input: unknown;
  iteration: number;
  permissionMode: PermissionMode;
  risk: ToolRisk;
  runId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  userId: string;
};

export type PreToolUseResult = {
  deny?: { reason: string };
  rewrite?: unknown;
};

export type PostToolUseContext = {
  durationMs: number;
  input: unknown;
  iteration: number;
  ok: boolean;
  output: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  userId: string;
};

export type CompactContext = {
  reason: "proactive" | "reactive";
  runId: string;
  sessionId: string;
  userId: string;
};

export type MessageEndContext = {
  error?: unknown;
  interrupted?: boolean;
  runId: string;
  sessionId: string;
  success: boolean;
  totalIterations: number;
  userId: string;
};

export type HookContexts = {
  message_end: MessageEndContext;
  post_compact: CompactContext & {
    messagesCompacted: number;
    messagesRetained: number;
  };
  post_model_response: PostModelResponseContext;
  post_tool_use: PostToolUseContext;
  pre_compact: CompactContext;
  pre_model_call: PreModelCallContext;
  pre_tool_use: PreToolUseContext;
};

export type HookResults = {
  message_end: void;
  post_compact: void;
  post_model_response: PostModelResponseResult | void;
  post_tool_use: void;
  pre_compact: void;
  pre_model_call: PreModelCallResult | void;
  pre_tool_use: PreToolUseResult | void;
};

export type HookHandler<E extends HookEvent> = (
  context: HookContexts[E],
) => HookResults[E] | Promise<HookResults[E]>;
