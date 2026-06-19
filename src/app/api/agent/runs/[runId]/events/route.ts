import { setTimeout as sleep } from "timers/promises";
import { NextRequest } from "next/server";

import { encodeAgentEvent } from "@/agent/events/sse";
import {
  isTerminalRunStatus,
  parseRunEventCursor,
} from "@/agent/runtime/RunEvents";
import { sessionRepository } from "@/agent/sessions/SessionRepository";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ runId: string }>;
};

const POLL_INTERVAL_MS = 500;

export async function GET(request: NextRequest, context: RouteContext) {
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

  const { runId } = await context.params;
  const run = await sessionRepository.getRunForUser({
    runId,
    userId: auth.user.id,
  });

  if (!run) {
    return Response.json(
      {
        error: "运行不存在",
        environment: getAuthEnvironment(),
      },
      { status: 404 },
    );
  }

  const encoder = new TextEncoder();
  let cursor = parseRunEventCursor({
    headerLastEventId:
      request.headers.get("last-event-id") ?? request.headers.get("Last-Event-ID"),
    queryAfter: request.nextUrl.searchParams.get("after"),
    queryLastEventId: request.nextUrl.searchParams.get("lastEventId"),
  });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (!request.signal.aborted) {
          const events = await sessionRepository.listRunEvents({
            afterId: cursor,
            runId,
            userId: auth.user.id,
          });

          for (const item of events) {
            cursor = item.id;
            controller.enqueue(
              encoder.encode(encodeAgentEvent(item.event, { id: item.id })),
            );
          }

          const latest = await sessionRepository.getRunForUser({
            runId,
            userId: auth.user.id,
          });

          if (events.length === 0 && latest && isTerminalRunStatus(latest.status)) {
            break;
          }

          await sleep(POLL_INTERVAL_MS, undefined, { signal: request.signal });
        }
      } catch (error) {
        if (!request.signal.aborted) {
          console.error("Failed to stream run events", error);
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
