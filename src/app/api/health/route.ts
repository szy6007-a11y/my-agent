import { NextRequest, NextResponse } from "next/server";

import { serverEnv } from "@/lib/env";
import { getAuthenticatedUser, getAuthEnvironment } from "@/lib/auth";
import {
  HEALTH_MONITOR_INTERVAL_MS,
  getServiceHealthSnapshot,
} from "@/lib/service-health";

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

  const snapshot = getServiceHealthSnapshot();
  const findService = (id: string) =>
    snapshot.services.find((service) => service.id === id);

  return NextResponse.json({
    status: snapshot.status,
    checkedAt: snapshot.checkedAt,
    uptimeSeconds: snapshot.uptimeSeconds,
    monitor: {
      intervalMs: HEALTH_MONITOR_INTERVAL_MS,
      streamUrl: "/api/health/stream",
    },
    services: {
      runtime: findService("runtime"),
      deepseek: {
        configured: Boolean(serverEnv.DEEPSEEK_API_KEY),
        status: findService("deepseek")?.state,
        baseUrl: serverEnv.DEEPSEEK_BASE_URL,
        defaultModel: serverEnv.DEEPSEEK_MODEL_DEFAULT,
        proModel: serverEnv.DEEPSEEK_MODEL_PRO,
      },
      database: {
        configured: Boolean(serverEnv.DATABASE_URL),
        status: findService("database")?.state,
      },
      redis: {
        configured: Boolean(serverEnv.REDIS_URL),
        status: findService("redis")?.state,
      },
    },
  });
}
