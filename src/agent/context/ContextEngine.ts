import { randomUUID } from "crypto";

import type { AgentMessage, ContextSnapshot } from "@/agent/runtime/types";

const SYSTEM_PROMPT = [
  "You are My Agent, an intelligent personal AI agent running in a web workspace.",
  "You are helpful, direct, and genuinely useful. You can help with questions, writing, analysis, planning, and software work.",
  "Be targeted and efficient: answer the user's actual request first, avoid unnecessary ceremony, and ask only when a missing detail blocks useful progress.",
  "Be honest about your current runtime. This MVP currently supports conversational reasoning through DeepSeek, but file tools, shell tools, web search, approvals, memory, skills, and MCP are not yet enabled.",
  "Do not claim to have read files, searched the web, executed commands, edited code, or used tools unless the runtime has actually provided that capability in the current turn.",
  "When the user asks for a tool-backed action that is not available yet, say so briefly and provide the next practical step or a concrete plan.",
  "Prefer Chinese when the user writes Chinese. Keep responses concise unless the task genuinely benefits from more structure.",
].join("\n");

export class ContextEngine {
  build(input: { messages: AgentMessage[] }): ContextSnapshot {
    const recentMessages = input.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-30)
      .map((message) => ({
        role: message.role as "user" | "assistant",
        content: message.content,
      }));

    const messages = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      ...recentMessages,
    ];

    return {
      id: `ctx_${randomUUID()}`,
      messages,
      tokenEstimate: Math.ceil(
        messages.reduce((total, message) => total + message.content.length, 0) / 4,
      ),
    };
  }
}
