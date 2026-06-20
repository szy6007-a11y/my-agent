import { NextResponse } from "next/server";

import { sessionRepository } from "@/agent/sessions/SessionRepository";
import { getAuthEnvironment } from "@/lib/auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ token: string }>;
};

function isShareToken(token: string) {
  return /^share_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    token,
  );
}

export async function GET(_request: Request, context: RouteContext) {
  const { token } = await context.params;

  if (!isShareToken(token)) {
    return NextResponse.json(
      {
        error: "分享链接无效",
        environment: getAuthEnvironment(),
      },
      { status: 404 },
    );
  }

  const share = await sessionRepository.getSharedSession(token);

  if (!share) {
    return NextResponse.json(
      {
        error: "分享链接不存在或已取消",
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
