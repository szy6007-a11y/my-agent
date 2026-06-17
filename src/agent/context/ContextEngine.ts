import { randomUUID } from "crypto";

import { PromptAssembler, type PromptAssembly } from "@/agent/context/PromptAssembler";
import { isContextSummaryMessage } from "@/agent/context/ContextSummary";
import type { AgentMessage, ContextSnapshot } from "@/agent/runtime/types";

function latestContextSummary(messages: AgentMessage[]): AgentMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isContextSummaryMessage(message)) {
      return message;
    }
  }

  return null;
}

function messagesAfterSummaryBoundary(
  messages: AgentMessage[],
  summary: AgentMessage | null,
): AgentMessage[] {
  if (!summary) {
    return messages;
  }

  const nonSummaryMessages = messages.filter((message) => !isContextSummaryMessage(message));
  const coveredUntilMessageId = summary.contextSummary?.coveredUntilMessageId;
  if (coveredUntilMessageId) {
    const coveredUntilIndex = nonSummaryMessages.findIndex(
      (message) => message.id === coveredUntilMessageId,
    );

    if (coveredUntilIndex >= 0) {
      return nonSummaryMessages.slice(coveredUntilIndex + 1);
    }
  }

  const summaryIndex = messages.findIndex((message) => message.id === summary.id);
  return summaryIndex >= 0 ? messages.slice(summaryIndex + 1) : nonSummaryMessages;
}

export class ContextEngine {
  constructor(private readonly promptAssembler = new PromptAssembler()) {}

  assemblePrompt(input: {
    availableTools?: string[];
    model?: string;
    provider?: string;
    sessionId?: string;
    userId?: string;
  }): PromptAssembly {
    return this.promptAssembler.assemble(input);
  }

  build(input: {
    availableTools?: string[];
    messages: AgentMessage[];
    model?: string;
    promptSnapshot?: PromptAssembly;
    provider?: string;
    sessionId?: string;
    userId?: string;
  }): ContextSnapshot {
    const summary = latestContextSummary(input.messages);
    const liveMessages = messagesAfterSummaryBoundary(input.messages, summary);
    const recentMessages = liveMessages
      .filter((message) => {
        if (isContextSummaryMessage(message)) {
          return false;
        }

        if (message.role === "user") {
          return true;
        }

        return message.role === "assistant" && !message.toolCalls?.length && message.content.trim();
      })
      .map((message) => ({
        role: message.role as "user" | "assistant",
        content: message.content,
      }));

    const systemPrompt =
      input.promptSnapshot ??
      this.assemblePrompt({
        availableTools: input.availableTools,
        model: input.model,
        provider: input.provider,
        sessionId: input.sessionId,
        userId: input.userId,
      });

    const messages = [
      { role: "system" as const, content: systemPrompt.prompt },
      ...(summary ? [{ role: "user" as const, content: summary.content }] : []),
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
