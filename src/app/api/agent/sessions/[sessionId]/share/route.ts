import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sessionRepository } from "@/agent/sessions/SessionRepository";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ sessionId: string }>;
};

const requestSchema = z.object({
  upToMessageId: z.string().min(1),
});

export async function POST(request: NextRequest, context: RouteContext) {
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
  const body = requestSchema.safeParse(await request.json().catch(() => null));

  if (!body.success) {
    return NextResponse.json(
      {
        error: "upToMessageId 无效",
        environment: getAuthEnvironment(),
      },
      { status: 400 },
    );
  }

  const share = await sessionRepository.createShareToken({
    sessionId,
    upToMessageId: body.data.upToMessageId,
    userId: auth.user.id,
  });

  if (!share) {
    return NextResponse.json(
      {
        error: "会话或消息不存在",
        environment: getAuthEnvironment(),
      },
      { status: 404 },
    );
  }

  return NextResponse.json({
    environment: getAuthEnvironment(),
    share,
  });
}
