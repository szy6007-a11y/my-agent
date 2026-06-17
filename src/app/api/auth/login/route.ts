import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  applyAuthCookie,
  getAuthEnvironment,
  getClientBucket,
  signInWithInviteCode,
} from "@/lib/auth";

export const runtime = "nodejs";

const loginSchema = z.object({
  displayName: z.string().trim().max(80).optional(),
  inviteCode: z.string().trim().min(1).max(160),
  userIdentifier: z.string().trim().min(1).max(120),
});

export async function POST(request: NextRequest) {
  const body = loginSchema.parse(await request.json());
  const result = await signInWithInviteCode({
    code: body.inviteCode,
    displayName: body.displayName,
    loginBucket: getClientBucket(request),
    userIdentifier: body.userIdentifier,
    userAgent: request.headers.get("user-agent"),
  });

  if ("error" in result) {
    return NextResponse.json(
      {
        error: result.error,
        environment: getAuthEnvironment(),
      },
      { status: result.status },
    );
  }

  const response = NextResponse.json({
    environment: getAuthEnvironment(),
    user: result.user,
  });

  applyAuthCookie(response, result.token, result.expiresAt);

  return response;
}
