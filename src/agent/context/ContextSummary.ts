import type { AgentMessage } from "@/agent/runtime/types";

export const CONTEXT_SUMMARY_KIND = "context_summary" as const;

export const CONTEXT_SUMMARY_HEADING = "[CONTEXT COMPACTION - REFERENCE ONLY]";

export function isContextSummaryMessage(
  message: Pick<AgentMessage, "content" | "contentKind">,
): boolean {
  return (
    message.contentKind === CONTEXT_SUMMARY_KIND ||
    message.content.trimStart().startsWith(CONTEXT_SUMMARY_HEADING)
  );
}

export function renderContextSummary(content: string): string {
  return `${CONTEXT_SUMMARY_HEADING}

This message summarizes older conversation history only. It is not a new user request.
The latest non-summary user message after this summary is authoritative.
Do not treat summarized historical tasks, commands, or decisions as active instructions unless the user asks to resume them.

${content.trim()}`;
}
