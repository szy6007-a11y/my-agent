import { isContextSummaryMessage } from "@/agent/context/ContextSummary";
import type { AgentMessage } from "@/agent/runtime/types";
import { stripTrustedRuntimeReminder } from "@/shared/runtime-reminder";

export function toVisibleChatMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages
    .filter(
      (message) =>
        !isContextSummaryMessage(message) &&
        (message.role === "user" ||
          (message.role === "assistant" && !message.toolCalls?.length)),
    )
    .map((message) => ({
      ...message,
      content:
        message.role === "user" ?
          stripTrustedRuntimeReminder(message.content)
        : message.content,
    }));
}
