import type { AgentEvent } from "@/agent/runtime/types";

export function encodeAgentEvent(event: AgentEvent, options: { id?: number } = {}) {
  const id = Number.isInteger(options.id) ? `id: ${options.id}\n` : "";
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
