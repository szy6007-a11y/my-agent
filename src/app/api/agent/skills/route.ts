import { NextRequest, NextResponse } from "next/server";

import { skillRepository } from "@/agent/skills/SkillRepository";
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

  return NextResponse.json({
    environment: getAuthEnvironment(),
    skills: await skillRepository.listActiveSkills(auth.user.id),
  });
}
