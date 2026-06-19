import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { sessionRepository } from "@/agent/sessions/SessionRepository";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ runId: string }>;
};

const requestSchema = z.object({
  reason: z.string().max(500).optional(),
});

async function parseBody(request: NextRequest) {
  try {
    return requestSchema.parse(await request.json());
  } catch {
    return {};
  }
}

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

  const { runId } = await context.params;
  const body = await parseBody(request);
  const run = await sessionRepository.abortRunForUser({
    reason: body.reason,
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
