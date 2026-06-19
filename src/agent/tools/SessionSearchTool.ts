import type {
  SessionDiscoveryResult,
  SessionSearchMessage,
  SessionWindowResult,
  StoredChatSession,
} from "@/agent/sessions/SessionRepository";
import type { AgentTool } from "@/agent/tools/types";
import { toolError } from "@/agent/tools/types";

type SessionSearchArgs = {
  around_message_id?: string;
  limit?: number;
  query?: string;
  role_filter?: string;
  session_id?: string;
  sort?: "newest" | "oldest";
  window?: number;
};

function asArgs(args: unknown): SessionSearchArgs {
  return args && typeof args === "object" ? (args as SessionSearchArgs) : {};
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseRoleFilter(raw: string | undefined): Array<"user" | "assistant" | "tool"> | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const roles = raw
    .split(",")
    .map((role) => role.trim())
    .filter((role): role is "user" | "assistant" | "tool" =>
      role === "user" || role === "assistant" || role === "tool",
    );

  return roles.length > 0 ? roles : undefined;
}

function toHermesMessage(message: SessionSearchMessage): Record<string, unknown> {
  return {
    ...(message.anchor ? { anchor: true } : {}),
    content: message.content,
    id: message.id,
    role: message.role,
    timestamp: message.createdAt,
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolName ? { tool_name: message.toolName } : {}),
  };
}

function toSessionMeta(session: SessionWindowResult["session"]): Record<string, unknown> {
  return {
    last_active: session.updatedAt,
    message_count: session.totalMessages,
    title: session.title,
    when: session.createdAt,
  };
}

function toDiscoveryResult(result: SessionDiscoveryResult): Record<string, unknown> {
  return {
    bookend_end: result.bookendEndMessages.map(toHermesMessage),
    bookend_start: result.bookendStartMessages.map(toHermesMessage),
    match_message_id: result.match.messageId,
    matched_role: result.match.role,
    messages: result.messages.map(toHermesMessage),
    messages_after: result.messagesAfter,
    messages_before: result.messagesBefore,
    rank: result.rank,
    session_id: result.session.id,
    snippet: result.match.snippet,
    title: result.session.title,
    when: result.session.createdAt,
  };
}

function toBrowseResult(session: StoredChatSession): Record<string, unknown> {
  return {
    last_active: session.updatedAt,
    message_count: session.messageCount,
    session_id: session.id,
    started_at: session.createdAt,
    title: session.title,
  };
}

export const sessionSearchTool: AgentTool = {
  name: "session_search",
  definition: {
    type: "function",
    function: {
      name: "session_search",
      description:
        "Long-term conversation recall for this user's past sessions. Single-shape tool with four modes inferred from args, no mode parameter: (1) DISCOVERY: pass query; searches persisted messages, dedupes by session, and returns top sessions with snippet, +/-5 message window around the match, plus bookend_start first 3 and bookend_end last 3 messages. (2) SCROLL: pass session_id + around_message_id; returns +/-window messages centered on the anchor, no discovery search and no bookends. To scroll, re-anchor on the first or last returned message id. (3) READ: pass session_id only; reads the session, returning all messages when small or first 20 + last 10 when large. (4) BROWSE: pass no args; lists recent sessions. Use this when the user references something from a past conversation, asks what happened previously, or likely needs cross-session context. Returns actual stored messages, never LLM summaries.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Discovery query. Omit to browse recent sessions. Ignored when session_id plus around_message_id are set. Uses the backend full-text index plus substring fallback.",
          },
          limit: {
            type: "integer",
            description: "Max sessions to return for discovery/browse. Default 3, max 10.",
          },
          sort: {
            type: "string",
            enum: ["newest", "oldest"],
            description:
              "Discovery temporal bias. Omit for relevance-first; use newest for where-did-we-leave-off questions.",
          },
          session_id: {
            type: "string",
            description:
              "Read or scroll a specific session. With around_message_id, returns a centered window; alone, reads first 20 + last 10 messages if large.",
          },
          around_message_id: {
            type: "string",
            description:
              "Message id to center a scroll window on. Use ids returned by discovery/read/scroll.",
          },
          window: {
            type: "integer",
            description: "Messages to return on each side of around_message_id. Default 5, max 20.",
          },
          role_filter: {
            type: "string",
            description:
              "Optional comma-separated roles for discovery: user,assistant,tool. Defaults to user,assistant.",
          },
        },
        required: [],
      },
    },
  },
  isReadOnly: true,
  async execute(args, context) {
    const input = asArgs(args);
    const limit = clampInt(input.limit, 3, 1, 10);
    const window = clampInt(input.window, 5, 1, 20);

    try {
      if (input.session_id?.trim() && input.around_message_id?.trim()) {
        const sessionId = input.session_id.trim();
        const aroundMessageId = input.around_message_id.trim();
        if (sessionId === context.sessionId) {
          return toolError(
            "scroll rejected: anchor lives in the current session (already in your active context)",
          );
        }

        const result = await context.sessions.getMessagesAround({
          aroundMessageId,
          sessionId,
          userId: context.userId,
          window,
        });
        if (!result) {
          return toolError(`around_message_id ${aroundMessageId} not in session_id ${sessionId}`);
        }
        return JSON.stringify({
          success: true,
          mode: "scroll",
          session_id: result.session.id,
          around_message_id: aroundMessageId,
          session_meta: toSessionMeta(result.session),
          window,
          messages: result.messages.map(toHermesMessage),
          messages_before: result.messagesBefore,
          messages_after: result.messagesAfter,
        });
      }

      if (input.session_id?.trim()) {
        const result = await context.sessions.readSessionWindow({
          sessionId: input.session_id.trim(),
          userId: context.userId,
        });
        if (!result) {
          return toolError(`session_id not found: ${input.session_id.trim()}`);
        }
        const truncated = result.messages.length < result.session.totalMessages;
        return JSON.stringify({
          success: true,
          mode: "read",
          session_id: result.session.id,
          session_meta: toSessionMeta(result.session),
          message_count: result.session.totalMessages,
          truncated,
          messages: result.messages.map(toHermesMessage),
          ...(truncated ?
            {
              message: `Session has ${result.session.totalMessages} messages; showing first 20 + last 10. Pass around_message_id (any id above) to scroll the middle.`,
            }
          : {}),
        });
      }

      if (!input.query?.trim()) {
        const sessions = await context.sessions.listSessions(context.userId, limit + 5, {
          excludeSessionId: context.sessionId,
        });
        const results = sessions.slice(0, limit).map(toBrowseResult);
        return JSON.stringify({
          success: true,
          mode: "browse",
          count: results.length,
          results,
          message: `Showing ${results.length} most recent sessions. Pass a query to search, or session_id+around_message_id to scroll.`,
        });
      }

      const results = await context.sessions.discoverSessions({
        limit,
        currentSessionId: context.sessionId,
        query: input.query.trim(),
        roleFilter: parseRoleFilter(input.role_filter),
        sort: input.sort,
        userId: context.userId,
      });
      return JSON.stringify({
        success: true,
        mode: "discover",
        query: input.query.trim(),
        count: results.length,
        results: results.map(toDiscoveryResult),
        sessions_searched: results.length,
        ...(results.length === 0 ? { message: "No matching sessions found." } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "session_search failed";
      return toolError(message);
    }
  },
};
