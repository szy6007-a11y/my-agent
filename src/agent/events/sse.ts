import type { AgentEvent } from "@/agent/runtime/types";

export function encodeAgentEvent(event: AgentEvent) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
