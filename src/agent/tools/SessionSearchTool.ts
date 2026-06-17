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

export const sessionSearchTool: AgentTool = {
  name: "session_search",
  definition: {
    type: "function",
    function: {
      name: "session_search",
      description:
        "Search this user's past sessions, read a session, or scroll around a message. Discovery uses the persisted message store and returns real messages, not LLM summaries. Use this for past task details, completed-work context, PR/issue/session history, and any 'what did we do about X' question.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Discovery query. Omit to browse recent sessions. Ignored when session_id plus around_message_id are set.",
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
  async execute(args, context) {
    const input = asArgs(args);
    const limit = clampInt(input.limit, 3, 1, 10);
    const window = clampInt(input.window, 5, 1, 20);

    try {
      if (input.session_id?.trim() && input.around_message_id?.trim()) {
        const result = await context.sessions.getMessagesAround({
          aroundMessageId: input.around_message_id.trim(),
          sessionId: input.session_id.trim(),
          userId: context.userId,
          window,
        });
        if (!result) {
          return toolError("session_id or around_message_id not found.");
        }
        return JSON.stringify({ success: true, mode: "scroll", ...result });
      }

      if (input.session_id?.trim()) {
        const result = await context.sessions.readSessionWindow({
          sessionId: input.session_id.trim(),
          userId: context.userId,
        });
        if (!result) {
          return toolError("session_id not found.");
        }
        return JSON.stringify({ success: true, mode: "read", ...result });
      }

      if (!input.query?.trim()) {
        const results = await context.sessions.listSessions(context.userId, limit);
        return JSON.stringify({
          success: true,
          mode: "browse",
          count: results.length,
          results,
          message: "Showing recent sessions. Pass query to search or session_id to read.",
        });
      }

      const results = await context.sessions.discoverSessions({
        limit,
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
        results,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "session_search failed";
      return toolError(message);
    }
  },
};
