import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApprovalController } from "@/agent/runtime/ApprovalController";
import { sessionRepository } from "@/agent/sessions/SessionRepository";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ approvalId: string }>;
};

const requestSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().max(1_000).optional(),
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

  const { approvalId } = await context.params;
  const body = requestSchema.parse(await request.json());
  const result = await new ApprovalController(sessionRepository).resolve({
    approvalId,
    decision: body.decision,
    reason: body.reason,
    userId: auth.user.id,
  });

  if (result.status === 200) {
    return NextResponse.json({
      approval: result.approval,
      environment: getAuthEnvironment(),
    });
  }

  if (result.status === 404) {
    return NextResponse.json(
      {
        error: result.error,
        environment: getAuthEnvironment(),
      },
      { status: 404 },
    );
  }

  return NextResponse.json(
    {
      approval: result.approval,
      environment: getAuthEnvironment(),
      error: result.error,
    },
    { status: 409 },
  );
}
