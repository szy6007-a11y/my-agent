import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { skillInstaller } from "@/agent/skills/SkillInstaller";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ skillId: string }>;
};

const requestSchema = z.object({
  action: z.enum(["enable", "disable", "uninstall"]),
});

export async function PATCH(request: NextRequest, context: RouteContext) {
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

  const { skillId } = await context.params;
  const body = requestSchema.parse(await request.json());
  const skill =
    body.action === "uninstall" ?
      await skillInstaller.uninstall({
        skillId,
        userId: auth.user.id,
      })
    : await skillInstaller.setEnabled({
        enabled: body.action === "enable",
        skillId,
        userId: auth.user.id,
      });

  return NextResponse.json({
    environment: getAuthEnvironment(),
    skill,
  });
}
