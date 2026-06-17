import { NextResponse } from "next/server";

import { serverEnv } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    services: {
      deepseek: {
        configured: Boolean(serverEnv.DEEPSEEK_API_KEY),
        baseUrl: serverEnv.DEEPSEEK_BASE_URL,
        defaultModel: serverEnv.DEEPSEEK_MODEL_DEFAULT,
        proModel: serverEnv.DEEPSEEK_MODEL_PRO,
      },
      database: {
        configured: Boolean(serverEnv.DATABASE_URL),
      },
      redis: {
        configured: Boolean(serverEnv.REDIS_URL),
      },
    },
  });
}
