import { randomUUID } from "crypto";

import { PromptAssembler } from "@/agent/context/PromptAssembler";
import type { AgentMessage, ContextSnapshot } from "@/agent/runtime/types";

export class ContextEngine {
  constructor(private readonly promptAssembler = new PromptAssembler()) {}

  build(input: {
    messages: AgentMessage[];
    model?: string;
    provider?: string;
    sessionId?: string;
  }): ContextSnapshot {
    const recentMessages = input.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-30)
      .map((message) => ({
        role: message.role as "user" | "assistant",
        content: message.content,
      }));

    const systemPrompt = this.promptAssembler.assemble({
      model: input.model,
      provider: input.provider,
      sessionId: input.sessionId,
    });

    const messages = [
      { role: "system" as const, content: systemPrompt.prompt },
      ...recentMessages,
    ];

    return {
      id: `ctx_${randomUUID()}`,
      messages,
      promptSections: systemPrompt.sections,
      promptTiers: systemPrompt.tiers,
      tokenEstimate: Math.ceil(
        messages.reduce((total, message) => total + message.content.length, 0) / 4,
      ),
    };
  }
}
