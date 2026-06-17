import { NextRequest, NextResponse } from "next/server";

import { clearAuthCookie, revokeAuthenticatedSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  await revokeAuthenticatedSession(request);

  const response = NextResponse.json({ ok: true });
  clearAuthCookie(response);

  return response;
}
