import assert from "node:assert/strict";
import test from "node:test";

import type {
  SessionDiscoveryResult,
  SessionWindowResult,
  StoredChatSession,
} from "@/agent/sessions/SessionRepository";
import type { ModelToolCall } from "@/agent/runtime/types";
import { sessionSearchTool } from "@/agent/tools/SessionSearchTool";
import type { ToolExecutionContext } from "@/agent/tools/types";

function toolCall(args: unknown): ModelToolCall {
  return {
    arguments: JSON.stringify(args),
    id: "call_session_search",
    name: "session_search",
  };
}

function makeContext(sessions: Partial<ToolExecutionContext["sessions"]>): ToolExecutionContext {
  return {
    runId: "run_test",
    sessionId: "sess_current",
    sessions: sessions as ToolExecutionContext["sessions"],
    userId: "usr_test",
  };
}

const baseWindow: SessionWindowResult = {
  bookendEnd: false,
  bookendStart: false,
  messages: [
    {
      anchor: true,
      content: "之前判断 web_search 没触发是因为 prompt 约束不够。",
      createdAt: "2026-06-01T00:01:00.000Z",
      id: "msg_match",
      role: "assistant",
    },
  ],
  messagesAfter: 4,
  messagesBefore: 2,
  session: {
    createdAt: "2026-06-01T00:00:00.000Z",
    id: "sess_old",
    title: "web_search 排查",
    totalMessages: 12,
    updatedAt: "2026-06-01T00:12:00.000Z",
  },
};

test("session_search discovery returns Hermes-style anchored results", async () => {
  let received: Record<string, unknown> | null = null;
  const discovery: SessionDiscoveryResult = {
    ...baseWindow,
    bookendEndMessages: [
      {
        content: "最后更新了 prompt。",
        createdAt: "2026-06-01T00:12:00.000Z",
        id: "msg_end",
        role: "assistant",
      },
    ],
    bookendStartMessages: [
      {
        content: "一开始的问题是 websearch 无法触发。",
        createdAt: "2026-06-01T00:00:00.000Z",
        id: "msg_start",
        role: "user",
      },
    ],
    match: {
      messageId: "msg_match",
      role: "assistant",
      snippet: "prompt 约束不够",
    },
    rank: 0.42,
  };
  const context = makeContext({
    discoverSessions: async (input) => {
      received = input;
      return [discovery];
    },
  });

  const raw = await sessionSearchTool.execute(
    { limit: 2, query: "web_search 无法触发", role_filter: "user,assistant", sort: "newest" },
    context,
    toolCall({}),
  );
  const result = JSON.parse(raw) as {
    count: number;
    mode: string;
    results: Array<{
      bookend_end: unknown[];
      bookend_start: unknown[];
      match_message_id: string;
      matched_role: string;
      messages: Array<{ anchor?: boolean; id: string; timestamp: string }>;
      session_id: string;
      snippet: string;
    }>;
    success: boolean;
  };

  assert.equal(result.success, true);
  assert.equal(result.mode, "discover");
  assert.equal(result.count, 1);
  assert.deepEqual(received, {
    currentSessionId: "sess_current",
    limit: 2,
    query: "web_search 无法触发",
    roleFilter: ["user", "assistant"],
    sort: "newest",
    userId: "usr_test",
  });
  assert.equal(result.results[0]?.session_id, "sess_old");
  assert.equal(result.results[0]?.match_message_id, "msg_match");
  assert.equal(result.results[0]?.matched_role, "assistant");
  assert.equal(result.results[0]?.snippet, "prompt 约束不够");
  assert.equal(result.results[0]?.messages[0]?.anchor, true);
  assert.equal(result.results[0]?.messages[0]?.timestamp, "2026-06-01T00:01:00.000Z");
  assert.equal(result.results[0]?.bookend_start.length, 1);
  assert.equal(result.results[0]?.bookend_end.length, 1);
});

test("session_search browse excludes the active session and uses Hermes field names", async () => {
  let receivedLimit = 0;
  let receivedOptions: unknown;
  const sessions: StoredChatSession[] = [
    {
      createdAt: "2026-06-02T00:00:00.000Z",
      endedAt: null,
      endReason: null,
      id: "sess_old",
      messageCount: 8,
      parentSessionId: null,
      status: "active",
      title: "旧会话",
      updatedAt: "2026-06-02T00:08:00.000Z",
    },
  ];
  const context = makeContext({
    listSessions: async (_userId, limit, options) => {
      receivedLimit = limit ?? 0;
      receivedOptions = options;
      return sessions;
    },
  });

  const raw = await sessionSearchTool.execute({}, context, toolCall({}));
  const result = JSON.parse(raw) as {
    results: Array<{ last_active: string; message_count: number; session_id: string; started_at: string }>;
    success: boolean;
  };

  assert.equal(result.success, true);
  assert.equal(receivedLimit, 8);
  assert.deepEqual(receivedOptions, { excludeSessionId: "sess_current" });
  assert.deepEqual(result.results, [
    {
      last_active: "2026-06-02T00:08:00.000Z",
      message_count: 8,
      session_id: "sess_old",
      started_at: "2026-06-02T00:00:00.000Z",
      title: "旧会话",
    },
  ]);
});

test("session_search scroll rejects the active session", async () => {
  let called = false;
  const context = makeContext({
    getMessagesAround: async () => {
      called = true;
      return baseWindow;
    },
  });

  const raw = await sessionSearchTool.execute(
    { around_message_id: "msg_current", session_id: "sess_current" },
    context,
    toolCall({}),
  );
  const result = JSON.parse(raw) as { error: string; success: boolean };

  assert.equal(result.success, false);
  assert.match(result.error, /current session/);
  assert.equal(called, false);
});

test("session_search read returns truncation metadata and Hermes message fields", async () => {
  const context = makeContext({
    readSessionWindow: async () => ({
      ...baseWindow,
      messages: [
        {
          content: "开头消息",
          createdAt: "2026-06-03T00:00:00.000Z",
          id: "msg_head",
          role: "user",
        },
        {
          content: "结尾消息",
          createdAt: "2026-06-03T00:40:00.000Z",
          id: "msg_tail",
          role: "assistant",
        },
      ],
      session: {
        ...baseWindow.session,
        totalMessages: 40,
      },
    }),
  });

  const raw = await sessionSearchTool.execute({ session_id: "sess_old" }, context, toolCall({}));
  const result = JSON.parse(raw) as {
    message: string;
    message_count: number;
    messages: Array<{ id: string; timestamp: string }>;
    mode: string;
    session_id: string;
    truncated: boolean;
  };

  assert.equal(result.mode, "read");
  assert.equal(result.session_id, "sess_old");
  assert.equal(result.message_count, 40);
  assert.equal(result.truncated, true);
  assert.match(result.message, /first 20 \+ last 10/);
  assert.deepEqual(result.messages[0], {
    content: "开头消息",
    id: "msg_head",
    role: "user",
    timestamp: "2026-06-03T00:00:00.000Z",
  });
});
