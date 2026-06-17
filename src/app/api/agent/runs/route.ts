import { NextRequest } from "next/server";
import { z } from "zod";

import { encodeAgentEvent } from "@/agent/events/sse";
import { RunController } from "@/agent/runtime/RunController";

export const runtime = "nodejs";

const requestSchema = z.object({
  agentId: z.string().optional(),
  maxTokens: z.number().int().min(1).max(4096).optional(),
  message: z.string().min(1),
  model: z.string().optional(),
  permissionMode: z
    .enum(["read-only", "ask-on-write", "auto-safe", "plan", "bypass"])
    .optional(),
  sessionId: z.string().nullish(),
  thinking: z.enum(["enabled", "disabled"]).optional(),
});

export async function POST(request: NextRequest) {
  const body = requestSchema.parse(await request.json());
  const encoder = new TextEncoder();
  const runController = new RunController();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runController.startRun(body, request.signal)) {
          controller.enqueue(encoder.encode(encodeAgentEvent(event)));
        }
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
