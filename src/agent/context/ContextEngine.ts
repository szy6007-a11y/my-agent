import { randomUUID } from "crypto";

import { PromptAssembler, type PromptAssembly } from "@/agent/context/PromptAssembler";
import { isContextSummaryMessage } from "@/agent/context/ContextSummary";
import type { AgentMessage, ContextSnapshot, ModelMessage } from "@/agent/runtime/types";
import { stripTrustedRuntimeReminder } from "@/shared/runtime-reminder";

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

function refreshModelLine(content: string, model: string | undefined): string {
  if (!model) {
    return content;
  }

  return content.replace(/^Model: .+$/m, `Model: ${model}`);
}

function refreshPromptSnapshotForRun(
  snapshot: PromptAssembly,
  input: { model?: string },
): PromptAssembly {
  if (!input.model) {
    return snapshot;
  }

  return {
    prompt: refreshModelLine(snapshot.prompt, input.model),
    sections: snapshot.sections.map((section) =>
      section.tag === "environment_context" ?
        { ...section, content: refreshModelLine(section.content, input.model) }
      : section,
    ),
    tiers: {
      context: snapshot.tiers.context,
      stable: snapshot.tiers.stable,
      volatile: refreshModelLine(snapshot.tiers.volatile, input.model),
    },
  };
}

export function promptSnapshotIsFresh(
  stored: PromptAssembly | null | undefined,
  current: PromptAssembly,
): stored is PromptAssembly {
  if (!stored) {
    return false;
  }
  if (stored.signature && current.signature) {
    return stored.signature === current.signature;
  }
  if (stored.metadata && current.metadata) {
    return (
      stored.metadata.promptVersion === current.metadata.promptVersion &&
      stored.metadata.availableToolsHash === current.metadata.availableToolsHash &&
      stored.metadata.skillIndexHash === current.metadata.skillIndexHash
    );
  }
  return stored.prompt === current.prompt;
}

function toModelMessage(
  message: AgentMessage,
  input: { preserveTrustedRuntimeReminder?: boolean } = {},
): ModelMessage | null {
  if (isContextSummaryMessage(message)) {
    return null;
  }

  if (message.role === "user") {
    const content =
      input.preserveTrustedRuntimeReminder ?
        message.content
      : stripTrustedRuntimeReminder(message.content);

    return content.trim() ? { role: "user", content } : null;
  }

  if (message.role === "assistant") {
    if (message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content.trim() ? message.content : null,
        toolCalls: message.toolCalls,
      };
    }

    return message.content.trim() ? { role: "assistant", content: message.content } : null;
  }

  if (message.role === "tool" && message.toolCallId) {
    return {
      role: "tool",
      content: message.content,
      toolCallId: message.toolCallId,
    };
  }

  return null;
}

function estimateModelMessages(messages: ModelMessage[]): number {
  return Math.ceil(
    messages.reduce((total, message) => {
      const contentLength = message.content?.length ?? 0;
      const toolCallsLength =
        message.role === "assistant" && message.toolCalls?.length ?
          JSON.stringify(message.toolCalls).length
        : 0;

      return total + contentLength + toolCallsLength;
    }, 0) / 4,
  );
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
    runtimeReminderMessageId?: string;
    sessionId?: string;
    userId?: string;
  }): ContextSnapshot {
    const summary = latestContextSummary(input.messages);
    const liveMessages = messagesAfterSummaryBoundary(input.messages, summary);
    const recentMessages = liveMessages
      .map((message) =>
        toModelMessage(message, {
          preserveTrustedRuntimeReminder: message.id === input.runtimeReminderMessageId,
        }),
      )
      .filter((message): message is ModelMessage => Boolean(message));

    const systemPrompt =
      input.promptSnapshot ?
        refreshPromptSnapshotForRun(input.promptSnapshot, { model: input.model })
      :
      this.assemblePrompt({
        availableTools: input.availableTools,
        model: input.model,
        provider: input.provider,
        sessionId: input.sessionId,
        userId: input.userId,
      });

    const messages: ModelMessage[] = [
      { role: "system" as const, content: systemPrompt.prompt },
      ...(summary ? [{ role: "user" as const, content: summary.content }] : []),
      ...recentMessages,
    ];

    return {
      id: `ctx_${randomUUID()}`,
      messages,
      promptSections: systemPrompt.sections,
      promptTiers: systemPrompt.tiers,
      tokenEstimate: estimateModelMessages(messages),
    };
  }
}
