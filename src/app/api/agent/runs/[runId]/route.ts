import { NextRequest, NextResponse } from "next/server";

import { sessionRepository } from "@/agent/sessions/SessionRepository";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ runId: string }>;
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

  const { runId } = await context.params;
  const run = await sessionRepository.getRunForUser({
    runId,
    userId: auth.user.id,
  });

  if (!run) {
    return NextResponse.json(
      {
        error: "运行不存在",
        environment: getAuthEnvironment(),
      },
      { status: 404 },
    );
  }

  return NextResponse.json({
    environment: getAuthEnvironment(),
    run,
  });
}
