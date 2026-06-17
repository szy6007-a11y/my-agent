import { NextRequest, NextResponse } from "next/server";

import { sessionRepository } from "@/agent/sessions/SessionRepository";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
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

  const sessions = await sessionRepository.listSessions(auth.user.id);

  return NextResponse.json({
    environment: getAuthEnvironment(),
    sessions,
  });
}
