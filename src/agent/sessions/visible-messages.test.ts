import assert from "node:assert/strict";
import test from "node:test";

import { CONTEXT_SUMMARY_KIND } from "@/agent/context/ContextSummary";
import type { AgentMessage } from "@/agent/runtime/types";
import { toVisibleChatMessages } from "@/agent/sessions/visible-messages";
import {
  SYSTEM_REMINDER_CLOSE_TAG,
  SYSTEM_REMINDER_OPEN_TAG,
  TRUSTED_SYSTEM_REMINDER_SENTINEL,
} from "@/shared/runtime-reminder";

function message(input: Partial<AgentMessage> & Pick<AgentMessage, "id" | "role" | "content">): AgentMessage {
  return {
    createdAt: "2026-06-20T00:00:00.000Z",
    ...input,
  };
}

test("toVisibleChatMessages returns the transcript surface shown to users", () => {
  const result = toVisibleChatMessages([
    message({
      content: "compact summary",
      contentKind: CONTEXT_SUMMARY_KIND,
      id: "msg_summary",
      role: "assistant",
    }),
    message({
      content: "planning",
      id: "msg_tool_plan",
      role: "assistant",
      toolCalls: [{ arguments: "{}", id: "call_1", name: "read_file" }],
    }),
    message({
      content: `${SYSTEM_REMINDER_OPEN_TAG}${TRUSTED_SYSTEM_REMINDER_SENTINEL}secret${SYSTEM_REMINDER_CLOSE_TAG}真实问题`,
      id: "msg_user",
      role: "user",
    }),
    message({
      content: "最终回答",
      id: "msg_assistant",
      role: "assistant",
    }),
    message({
      content: "tool result",
      id: "msg_tool",
      role: "tool",
    }),
  ]);

  assert.deepEqual(
    result.map((item) => ({ content: item.content, id: item.id, role: item.role })),
    [
      { content: "真实问题", id: "msg_user", role: "user" },
      { content: "最终回答", id: "msg_assistant", role: "assistant" },
    ],
  );
});
