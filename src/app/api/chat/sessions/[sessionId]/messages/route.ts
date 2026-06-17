import { NextRequest, NextResponse } from "next/server";

import { sessionRepository } from "@/agent/sessions/SessionRepository";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await getAuthenticatedUser(request);

  if (!auth) {
    return NextResponse.json(
      {
        error: "未登录",
        environment: getAuthEnvironment(),
      },
      { status: 401 },
    );
  }

  const { sessionId } = await context.params;
  const session = await sessionRepository.getSessionForUser(
    sessionId,
    auth.user.id,
  );

  if (!session) {
    return NextResponse.json(
      {
        error: "会话不存在",
        environment: getAuthEnvironment(),
      },
      { status: 404 },
    );
  }

  const messages = await sessionRepository.listMessages(sessionId, {
    limit: 120,
    userId: auth.user.id,
  });

  return NextResponse.json({
    environment: getAuthEnvironment(),
    messages: messages.filter((message) =>
      message.role === "user" || message.role === "assistant",
    ),
    session,
  });
}
