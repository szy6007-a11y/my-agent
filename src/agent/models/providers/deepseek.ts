import type OpenAI from "openai";

import {
  type ModelStreamEvent,
  type ModelStreamInput,
  type ProviderAdapter,
} from "@/agent/models/ProviderAdapter";
import { deepseek } from "@/lib/ai/deepseek";

type DeepSeekStreamingParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
    thinking: { type: "enabled" | "disabled" };
  };

type DeepSeekDelta = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string;
};

export class DeepSeekProviderAdapter implements ProviderAdapter {
  async *stream(input: ModelStreamInput): AsyncGenerator<ModelStreamEvent> {
    const completionParams: DeepSeekStreamingParams = {
      max_tokens: input.maxTokens,
      messages: input.context.messages,
      model: input.model,
      stream: true,
      thinking: { type: input.thinking },
    };

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

      if (chunk.usage) {
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
    }
  }
}
