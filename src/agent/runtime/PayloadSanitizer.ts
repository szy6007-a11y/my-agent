import type { ModelMessage, ModelToolCall } from "@/agent/runtime/types";

const MISSING_TOOL_RESULT_STUB =
  "[tool_result_unavailable: 上一次工具调用结果缺失。请基于现有上下文继续，不要假设工具已经成功返回。]";
const CORRUPTED_TOOL_ARGUMENTS_STUB =
  "[tool_arguments_repaired: 上一次工具调用参数不是合法 JSON，运行时已将该工具参数替换为空对象。]";

export type PayloadSanitizeStats = {
  insertedMissingToolResults: number;
  invalidToolArguments: number;
  removedOrphanToolResults: number;
};

export type PayloadSanitizeResult = {
  changed: boolean;
  messages: ModelMessage[];
  stats: PayloadSanitizeStats;
};

function validToolCallIds(message: ModelMessage): string[] {
  if (message.role !== "assistant" || !message.toolCalls?.length) {
    return [];
  }

  return message.toolCalls
    .map((toolCall) => toolCall.id)
    .filter((id) => id.trim().length > 0);
}

function sanitizeToolCalls(toolCalls: ModelToolCall[], stats: PayloadSanitizeStats) {
  let changed = false;
  const repaired = toolCalls.map((toolCall) => {
    if (!toolCall.arguments.trim()) {
      return { ...toolCall, arguments: "{}" };
    }

    try {
      JSON.parse(toolCall.arguments);
      return toolCall;
    } catch {
      changed = true;
      stats.invalidToolArguments += 1;
      return { ...toolCall, arguments: "{}" };
    }
  });

  return { changed, toolCalls: repaired };
}

export function sanitizeModelMessages(messages: ModelMessage[]): PayloadSanitizeResult {
  const stats: PayloadSanitizeStats = {
    insertedMissingToolResults: 0,
    invalidToolArguments: 0,
    removedOrphanToolResults: 0,
  };
  const sanitized: ModelMessage[] = [];
  let changed = false;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === "tool") {
      stats.removedOrphanToolResults += 1;
      changed = true;
      continue;
    }

    if (message.role !== "assistant" || !message.toolCalls?.length) {
      sanitized.push(message);
      continue;
    }

    const repaired = sanitizeToolCalls(message.toolCalls, stats);
    changed = changed || repaired.changed;
    const assistantMessage: ModelMessage = {
      ...message,
      toolCalls: repaired.toolCalls,
    };
    sanitized.push(assistantMessage);

    const expected = new Set(validToolCallIds(assistantMessage));
    const satisfied = new Set<string>();
    let scanIndex = index + 1;

    while (scanIndex < messages.length && messages[scanIndex].role === "tool") {
      const toolMessage = messages[scanIndex] as Extract<ModelMessage, { role: "tool" }>;
      if (expected.has(toolMessage.toolCallId) && !satisfied.has(toolMessage.toolCallId)) {
        sanitized.push(toolMessage);
        satisfied.add(toolMessage.toolCallId);
      } else {
        stats.removedOrphanToolResults += 1;
        changed = true;
      }
      scanIndex += 1;
    }

    index = scanIndex - 1;

    for (const toolCallId of expected) {
      if (!satisfied.has(toolCallId)) {
        sanitized.push({
          role: "tool",
          content:
            repaired.changed ? CORRUPTED_TOOL_ARGUMENTS_STUB : MISSING_TOOL_RESULT_STUB,
          toolCallId,
        });
        stats.insertedMissingToolResults += 1;
        changed = true;
      }
    }
  }

  return {
    changed:
      changed ||
      stats.insertedMissingToolResults > 0 ||
      stats.invalidToolArguments > 0 ||
      stats.removedOrphanToolResults > 0,
    messages: changed ? sanitized : messages,
    stats,
  };
}
