import type { RunStatus } from "@/agent/runtime/types";

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "aborted",
  "expired",
]);

export const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  "preparing",
  "streaming_model",
  "waiting_approval",
  "executing_tools",
  "compacting",
  "finalizing",
]);

export const RUN_QUEUE_MODES = ["followup", "interrupt", "steer", "collect"] as const;

export type RunQueueMode = (typeof RUN_QUEUE_MODES)[number];

export function isRunQueueMode(value: unknown): value is RunQueueMode {
  return (
    value === "followup" ||
    value === "interrupt" ||
    value === "steer" ||
    value === "collect"
  );
}

export function isActiveRunStatus(status: RunStatus | null | undefined): boolean {
  return status ? ACTIVE_RUN_STATUSES.has(status) : false;
}

export function isTerminalRunStatus(status: RunStatus | null | undefined): boolean {
  return status ? TERMINAL_RUN_STATUSES.has(status) : false;
}

export function parseRunEventCursor(input: {
  headerLastEventId?: string | null;
  queryAfter?: string | null;
  queryLastEventId?: string | null;
}): number | undefined {
  const raw =
    input.queryAfter?.trim() ||
    input.queryLastEventId?.trim() ||
    input.headerLastEventId?.trim();

  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}
