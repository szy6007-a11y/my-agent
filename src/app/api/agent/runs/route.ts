import { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";

import { encodeAgentEvent } from "@/agent/events/sse";
import { RunController } from "@/agent/runtime/RunController";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";

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
  const auth = await getAuthenticatedUser(request);

  if (!auth) {
    return Response.json(
      {
        error: "未登录",
        environment: getAuthEnvironment(),
      },
      { status: 401 },
    );
  }

  const body = requestSchema.parse(await request.json());
  const encoder = new TextEncoder();
  const runController = new RunController();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of runController.startRun(
          body,
          request.signal,
          auth.user.id,
        )) {
          controller.enqueue(encoder.encode(encodeAgentEvent(event)));
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown agent error";
        console.error("Failed to start agent run", error);
        controller.enqueue(
          encoder.encode(
            encodeAgentEvent({
              type: "run.failed",
              runId: `run_${randomUUID()}`,
              error: message,
            }),
          ),
        );
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
