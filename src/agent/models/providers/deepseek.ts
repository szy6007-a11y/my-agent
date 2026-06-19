import type OpenAI from "openai";

import {
  type ModelStreamEvent,
  type ModelStreamInput,
  type ProviderAdapter,
} from "@/agent/models/ProviderAdapter";
import type { ModelMessage, ModelToolCall } from "@/agent/runtime/types";
import { getDeepSeekClient } from "@/lib/ai/deepseek";

type DeepSeekStreamingParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
    thinking: { type: "enabled" | "disabled" };
  };

type DeepSeekDelta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string;
  tool_calls?: Array<{
    function?: {
      arguments?: string;
      name?: string;
    };
    id?: string;
    index?: number;
  }>;
};

type ToolCallAccumulator = {
  arguments: string;
  id?: string;
  name?: string;
};

function toDeepSeekMessages(
  messages: ModelMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls && message.toolCalls.length > 0 ?
          {
            tool_calls: message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: "function" as const,
              function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            })),
          }
        : {}),
      };
    }

    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId,
      };
    }

    return message;
  });
}

function toToolCalls(parts: Map<number, ToolCallAccumulator>): ModelToolCall[] {
  return [...parts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, part]) => ({
      id: part.id ?? `tool_call_${index}`,
      name: part.name ?? "",
      arguments: part.arguments,
    }))
    .filter((toolCall) => toolCall.name.length > 0);
}

function toolCallArgumentChars(parts: Map<number, ToolCallAccumulator>): number {
  let total = 0;
  for (const part of parts.values()) {
    total += part.arguments.length;
  }
  return total;
}

function normalizeDeepSeekStreamError(input: {
  error: unknown;
  reportedToolCallStart: boolean;
  toolCallParts: Map<number, ToolCallAccumulator>;
}): Error {
  if (input.error instanceof Error && input.error.name === "AbortError") {
    return input.error;
  }

  const message =
    input.error instanceof Error ? input.error.message
    : typeof input.error === "string" ? input.error
    : "DeepSeek streaming response failed";

  if (/terminated/i.test(message)) {
    const partialChars = toolCallArgumentChars(input.toolCallParts);
    const toolContext =
      input.reportedToolCallStart ?
        `，当时模型已经开始生成工具调用参数（已接收约 ${partialChars} 个字符）`
      : "";
    return new Error(
      `DeepSeek 流式响应在完成前中断${toolContext}。这通常是上游连接断开；如果正在生成 HTML/PPT 等文件，常见原因是单次工具参数过长。请改用 write_file_chunk 分段写入，或减少页数/内容后再生成。`,
    );
  }

  return input.error instanceof Error ? input.error : new Error(message);
}

export class DeepSeekProviderAdapter implements ProviderAdapter {
  async *stream(input: ModelStreamInput): AsyncGenerator<ModelStreamEvent> {
    const completionParams: DeepSeekStreamingParams = {
      max_tokens: input.maxTokens,
      messages: toDeepSeekMessages(input.context.messages),
      model: input.model,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: input.thinking },
      ...(input.tools && input.tools.length > 0 ?
        {
          tool_choice: "auto",
          tools: input.tools as OpenAI.Chat.Completions.ChatCompletionTool[],
        }
      : {}),
    };
    const deepseek = getDeepSeekClient({
      generationMetadata: {
        contextSnapshotId: input.context.id,
        provider: "deepseek",
        runId: input.runId,
        thinking: input.thinking,
        tokenEstimate: input.context.tokenEstimate,
      },
      generationName: "deepseek-chat-completion",
      sessionId: input.sessionId,
      tags: ["agent", "chat", "deepseek"],
      traceName: "agent-chat-run",
      userId: input.userId,
    });

    const toolCallParts = new Map<number, ToolCallAccumulator>();
    let reportedToolCallStart = false;

    try {
      const stream = await deepseek.chat.completions.create(completionParams, {
        signal: input.signal,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as DeepSeekDelta | undefined;

        if (delta?.reasoning_content) {
          yield { type: "reasoning_delta", text: delta.reasoning_content };
        }

        if (delta?.content) {
          yield { type: "text_delta", text: delta.content };
        }

        const partialToolCalls = delta?.tool_calls ?? [];
        if (partialToolCalls.length > 0 && !reportedToolCallStart) {
          reportedToolCallStart = true;
          yield { type: "tool_call_started" };
        }

        for (const partial of partialToolCalls) {
          const index = partial.index ?? toolCallParts.size;
          const current = toolCallParts.get(index) ?? { arguments: "" };
          current.id = partial.id ?? current.id;
          current.name = partial.function?.name ?? current.name;
          current.arguments += partial.function?.arguments ?? "";
          toolCallParts.set(index, current);
        }

        if (chunk.usage) {
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
      }
    } catch (error) {
      throw normalizeDeepSeekStreamError({
        error,
        reportedToolCallStart,
        toolCallParts,
      });
    }

    const toolCalls = toToolCalls(toolCallParts);
    if (toolCalls.length > 0) {
      yield { type: "tool_calls", toolCalls };
    }
  }
}
