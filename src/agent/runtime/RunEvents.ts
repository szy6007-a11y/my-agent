import type { RunStatus } from "@/agent/runtime/types";

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "aborted",
  "expired",
]);

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
