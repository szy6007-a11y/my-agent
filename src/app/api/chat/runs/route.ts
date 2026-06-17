import { NextRequest } from "next/server";
import type OpenAI from "openai";
import { z } from "zod";

import { deepseek, deepseekModels } from "@/lib/ai/deepseek";

export const runtime = "nodejs";

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

const requestSchema = z.object({
  messages: z.array(messageSchema).min(1),
  maxTokens: z.number().int().min(1).max(4096).optional(),
  model: z.string().optional(),
  thinking: z.enum(["enabled", "disabled"]).default("disabled"),
});

type DeepSeekStreamingParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
    thinking: { type: "enabled" | "disabled" };
  };

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(request: NextRequest) {
  const body = requestSchema.parse(await request.json());
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sse(event, data)));
      };

      try {
        send("run.created", {
          model: body.model ?? deepseekModels.default,
          createdAt: new Date().toISOString(),
        });

        const completionParams: DeepSeekStreamingParams = {
          max_tokens: body.maxTokens ?? 1024,
          model: body.model ?? deepseekModels.default,
          messages: body.messages,
          stream: true,
          thinking: { type: body.thinking },
        };

        const completion =
          await deepseek.chat.completions.create(completionParams);

        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content;

          if (delta) {
            send("message.delta", { delta });
          }
        }

        send("run.completed", {
          completedAt: new Date().toISOString(),
        });
      } catch (error) {
        send("run.error", {
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}
