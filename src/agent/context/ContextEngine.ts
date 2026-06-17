import { randomUUID } from "crypto";

import type { AgentMessage, ContextSnapshot } from "@/agent/runtime/types";

const SYSTEM_PROMPT = [
  "你是 My Agent，一个运行在网页端的 DeepSeek Agent 原型。",
  "你要用简洁、准确的中文回答用户。",
  "当前 MVP 只启用了无工具聊天。不要假装已经读取文件、联网搜索或执行命令。",
  "如果用户要求工具能力，说明当前原型还未接入该工具，并给出可执行的下一步。",
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
