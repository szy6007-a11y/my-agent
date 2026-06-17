import { join, resolve } from "path";

import { serverEnv } from "@/lib/env";

function safeSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  return normalized.slice(0, 96) || "anonymous";
}

export function getMemoryRoot(): string {
  return resolve(serverEnv.MEMORY_DIR ?? join(process.cwd(), ".my-agent", "memories"));
}

export function getUserMemoryDir(userId: string): string {
  return join(getMemoryRoot(), serverEnv.APP_ENV, safeSegment(userId));
}

export function displayUserMemoryDir(userId: string): string {
  return getUserMemoryDir(userId).replace(process.cwd(), ".");
}
