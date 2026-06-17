import { serverEnv } from "@/lib/env";

export const HEALTH_MONITOR_INTERVAL_MS = 5000;
export const HEALTH_HEARTBEAT_INTERVAL_MS = 15000;

export type ServiceHealthState = "ok" | "warning" | "disabled";
export type ServiceHealthStatus = "ok" | "degraded";

export type ServiceHealthItem = {
  id: "runtime" | "deepseek" | "database" | "redis";
  label: string;
  state: ServiceHealthState;
  message: string;
  detail?: string;
  required: boolean;
};

export type ServiceHealthSnapshot = {
  status: ServiceHealthStatus;
  checkedAt: string;
  uptimeSeconds: number;
  services: ServiceHealthItem[];
};

export function getServiceHealthSnapshot(
  now = new Date(),
): ServiceHealthSnapshot {
  const deepseekConfigured = Boolean(serverEnv.DEEPSEEK_API_KEY);
  const databaseConfigured = Boolean(serverEnv.DATABASE_URL);
  const redisConfigured = Boolean(serverEnv.REDIS_URL);

  const services: ServiceHealthItem[] = [
    {
      id: "runtime",
      label: "Next.js 服务",
      state: "ok",
      message: "HTTP 运行中",
      detail: `pid ${process.pid}`,
      required: true,
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      state: deepseekConfigured ? "ok" : "warning",
      message: deepseekConfigured ? "模型服务已配置" : "缺少 API Key",
      detail: serverEnv.DEEPSEEK_MODEL_DEFAULT,
      required: true,
    },
    {
      id: "database",
      label: "PostgreSQL",
      state: databaseConfigured ? "ok" : "warning",
      message: databaseConfigured ? "会话持久化已配置" : "缺少 DATABASE_URL",
      required: true,
    },
    {
      id: "redis",
      label: "Redis",
      state: redisConfigured ? "ok" : "disabled",
      message: redisConfigured ? "缓存通道已配置" : "未启用缓存",
      required: false,
    },
  ];

  const hasRequiredWarning = services.some(
    (service) => service.required && service.state !== "ok",
  );

  return {
    status: hasRequiredWarning ? "degraded" : "ok",
    checkedAt: now.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    services,
  };
}

export function serviceHealthFingerprint(snapshot: ServiceHealthSnapshot) {
  return snapshot.services
    .map((service) => `${service.id}:${service.state}:${service.message}`)
    .join("|");
}

export function describeServiceHealth(snapshot: ServiceHealthSnapshot) {
  const warnings = snapshot.services.filter(
    (service) => service.required && service.state !== "ok",
  );

  if (warnings.length === 0) {
    return "所有必需服务运行正常";
  }

  return `需要关注：${warnings.map((service) => service.label).join("、")}`;
}
