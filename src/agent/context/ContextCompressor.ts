import { randomUUID } from "crypto";

import { ModelRouter } from "@/agent/models/ModelRouter";
import type { AgentMessage, ContextSnapshot, ModelMessage } from "@/agent/runtime/types";
import {
  CONTEXT_SUMMARY_KIND,
  isContextSummaryMessage,
  renderContextSummary,
} from "@/agent/context/ContextSummary";
import { type SessionRepository, sessionRepository } from "@/agent/sessions/SessionRepository";
import { serverEnv } from "@/lib/env";

const HERMES_MINIMUM_CONTEXT_LENGTH = 64_000;
const HERMES_PROTECT_LAST_N = 20;
const HERMES_SUMMARY_TARGET_RATIO = 0.20;
const HERMES_SUMMARY_TOKENS_CEILING = 12_000;
const MAX_TAIL_MESSAGE_FLOOR = 8;
const MESSAGE_CONTENT_CHAR_LIMIT = 2_400;
const TOOL_CONTENT_CHAR_LIMIT = 1_200;

type PromptTiers = ContextSnapshot["promptTiers"];

type CompressionOptions = {
  contextWindowTokens?: number;
  minimumContextTokens?: number;
  protectLastN?: number;
  summaryTargetRatio?: number;
  thresholdPercent?: number;
};

type CompressionWindow = {
  coveredUntilMessageId: string;
  latestSummary: AgentMessage | null;
  summarizedMessages: AgentMessage[];
};

export type ContextCompressionResult = {
  afterTokenEstimate: number;
  beforeTokenEstimate: number;
  compacted: boolean;
  compactedMessageCount: number;
  messages: AgentMessage[];
  summaryMessageId?: string;
};

export function estimateAgentMessages(messages: AgentMessage[]): number {
  return Math.ceil(
    messages.reduce((total, message) => {
      const toolCalls = message.toolCalls ? JSON.stringify(message.toolCalls) : "";
      return total + message.content.length + toolCalls.length;
    }, 0) / 4,
  );
}

function estimateModelMessages(messages: ModelMessage[]): number {
  return Math.ceil(
    messages.reduce((total, message) => {
      if (message.role === "assistant" && message.toolCalls?.length) {
        return total + (message.content?.length ?? 0) + JSON.stringify(message.toolCalls).length;
      }

      return total + (message.content?.length ?? 0);
    }, 0) / 4,
  );
}

function truncateForSummary(text: string, maxChars: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.floor(maxChars * 0.2);
  return `${normalized.slice(0, headChars)}

[...middle omitted for context compression...]

${normalized.slice(-tailChars)}`;
}

function messageText(message: AgentMessage): string {
  const createdAt = message.createdAt ? ` at ${message.createdAt}` : "";
  const toolName = message.toolName ? ` ${message.toolName}` : "";

  if (message.role === "tool") {
    return `TOOL_RESULT${toolName}${createdAt}:
${truncateForSummary(message.content, TOOL_CONTENT_CHAR_LIMIT)}`;
  }

  if (message.role === "assistant" && message.toolCalls?.length) {
    const calls = message.toolCalls
      .map((toolCall) => `${toolCall.name}(${truncateForSummary(toolCall.arguments, 600)})`)
      .join("\n");
    const content = message.content.trim() ? `\n${truncateForSummary(message.content, 900)}` : "";
    return `ASSISTANT_TOOL_CALLS${createdAt}:
${calls}${content}`;
  }

  return `${message.role.toUpperCase()}${createdAt}:
${truncateForSummary(message.content, MESSAGE_CONTENT_CHAR_LIMIT)}`;
}

function renderTranscript(messages: AgentMessage[]): string {
  return messages.map(messageText).join("\n\n---\n\n");
}

function emptyPromptTiers(): PromptTiers {
  return {
    context: "<project_context_layer status=\"empty\">\n</project_context_layer>",
    stable: "<stable_context status=\"empty\">\n</stable_context>",
    volatile: "<volatile_context status=\"empty\">\n</volatile_context>",
  };
}

function buildSummaryPrompt(input: {
  latestSummary: AgentMessage | null;
  summarizedMessages: AgentMessage[];
}): string {
  const previousSummary =
    input.latestSummary ?
      `Previous compacted summary:
${input.latestSummary.content}`
    : "Previous compacted summary: none";

  return `Summarize older conversation turns into a durable handoff for the same session.

${previousSummary}

New older turns to fold into the summary:
${renderTranscript(input.summarizedMessages)}

Write only the updated summary body. Do not include greetings or meta commentary.
Use concrete, inspectable details: user intent, constraints, decisions, completed actions, active state, blockers, relevant files, commands, errors, and tool results.
Keep historical items historical. Do not phrase old tasks as fresh instructions.
If a secret, token, cookie, or credential appears, describe only that a secret-like value was present; do not copy it.

Use these sections exactly:
## Historical Task Snapshot
## User Preferences And Constraints
## Completed Actions
## Active State
## Blocked Or Risky Areas
## Relevant Files And Commands
## Open Questions
## Recommended Next Step`;
}

function selectCompressionWindow(
  messages: AgentMessage[],
  protectLastN: number,
  tailTokenBudget: number,
): CompressionWindow {
  let latestSummaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isContextSummaryMessage(messages[index])) {
      latestSummaryIndex = index;
      break;
    }
  }
  const latestSummary = latestSummaryIndex >= 0 ? messages[latestSummaryIndex] : null;
  const nonSummaryMessages = messages.filter(
    (message) => !isContextSummaryMessage(message) && message.content.trim(),
  );
  const coveredUntilMessageId = latestSummary?.contextSummary?.coveredUntilMessageId;
  const coveredUntilIndex =
    coveredUntilMessageId ?
      nonSummaryMessages.findIndex((message) => message.id === coveredUntilMessageId)
    : -1;
  const legacyBoundary =
    latestSummary && !coveredUntilMessageId && latestSummaryIndex >= 0 ?
      messages.slice(latestSummaryIndex + 1).filter(
        (message) => !isContextSummaryMessage(message) && message.content.trim(),
      )
    : null;
  const compressibleMessages =
    legacyBoundary ??
    nonSummaryMessages.slice(coveredUntilIndex >= 0 ? coveredUntilIndex + 1 : 0);
  const tailStart = findTailStartByTokens(compressibleMessages, protectLastN, tailTokenBudget);
  const summarizedMessages = compressibleMessages.slice(0, tailStart);
  const coveredUntil = summarizedMessages[summarizedMessages.length - 1];

  return {
    coveredUntilMessageId: coveredUntil?.id ?? coveredUntilMessageId ?? "",
    latestSummary,
    summarizedMessages,
  };
}

function estimateMessageTokens(message: AgentMessage): number {
  const toolCalls = message.toolCalls ? JSON.stringify(message.toolCalls) : "";
  return Math.ceil((message.content.length + toolCalls.length) / 4) + 10;
}

function findTailStartByTokens(
  messages: AgentMessage[],
  protectLastN: number,
  tailTokenBudget: number,
): number {
  const availableTail = Math.max(0, messages.length - 1);
  const minTailFloor = Math.max(3, Math.min(protectLastN, MAX_TAIL_MESSAGE_FLOOR));
  const compressibleTailCap = Math.max(3, availableTail - 2);
  const minTail =
    availableTail > 1 ? Math.min(minTailFloor, compressibleTailCap, availableTail) : 0;
  const softCeiling = Math.floor(tailTokenBudget * 1.5);
  let accumulated = 0;
  let cutIndex = messages.length;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageTokens = estimateMessageTokens(messages[index]);
    if (accumulated + messageTokens > softCeiling && messages.length - index >= minTail) {
      break;
    }

    accumulated += messageTokens;
    cutIndex = index;
  }

  if (cutIndex <= 0 && accumulated <= softCeiling && accumulated > 0) {
    let rawAccumulated = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const messageTokens = estimateMessageTokens(messages[index]);
      if (rawAccumulated + messageTokens > tailTokenBudget && messages.length - index >= minTail) {
        cutIndex = index;
        break;
      }

      rawAccumulated += messageTokens;
      cutIndex = index;
    }
  }

  const fallbackCut = messages.length - minTail;
  cutIndex = Math.min(cutIndex, fallbackCut);

  if (cutIndex <= 0) {
    cutIndex = Math.max(fallbackCut, 1);
  }

  return cutIndex;
}

function estimateProjectedCompressedHistory(
  messages: AgentMessage[],
  protectLastN: number,
): number {
  let latestSummary: AgentMessage | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isContextSummaryMessage(messages[index])) {
      latestSummary = messages[index];
      break;
    }
  }

  const recentMessages = messages
    .filter((message) => !isContextSummaryMessage(message) && message.content.trim())
    .slice(-protectLastN);

  return estimateAgentMessages([
    ...(latestSummary ? [latestSummary] : []),
    ...recentMessages,
  ]);
}

export class ContextCompressor {
  private readonly maxSummaryTokens: number;
  private readonly protectLastN: number;
  private readonly tailTokenBudget: number;
  private readonly thresholdTokens: number;

  constructor(
    private readonly modelRouter = new ModelRouter(),
    private readonly sessions: SessionRepository = sessionRepository,
    options: CompressionOptions = {},
  ) {
    const contextWindowTokens = options.contextWindowTokens ?? serverEnv.DEEPSEEK_CONTEXT_WINDOW_TOKENS;
    const thresholdPercent =
      options.thresholdPercent ?? serverEnv.CONTEXT_COMPRESSION_THRESHOLD_PERCENT;
    const minimumContextTokens = options.minimumContextTokens ?? HERMES_MINIMUM_CONTEXT_LENGTH;
    const summaryTargetRatio = Math.max(
      0.10,
      Math.min(options.summaryTargetRatio ?? HERMES_SUMMARY_TARGET_RATIO, 0.80),
    );

    this.thresholdTokens = Math.max(
      Math.floor(contextWindowTokens * thresholdPercent),
      minimumContextTokens,
    );
    this.protectLastN = options.protectLastN ?? HERMES_PROTECT_LAST_N;
    this.tailTokenBudget = Math.floor(this.thresholdTokens * summaryTargetRatio);
    this.maxSummaryTokens = Math.min(
      Math.floor(contextWindowTokens * 0.05),
      HERMES_SUMMARY_TOKENS_CEILING,
    );
  }

  async maybeCompress(input: {
    force?: boolean;
    messages: AgentMessage[];
    model: string;
    runId: string;
    sessionId: string;
    signal: AbortSignal;
    userId: string;
  }): Promise<ContextCompressionResult> {
    const beforeTokenEstimate = estimateAgentMessages(input.messages);
    const unchanged = {
      afterTokenEstimate: beforeTokenEstimate,
      beforeTokenEstimate,
      compacted: false,
      compactedMessageCount: 0,
      messages: input.messages,
    };

    if (!input.force && beforeTokenEstimate < this.thresholdTokens) {
      return unchanged;
    }

    const window = selectCompressionWindow(input.messages, this.protectLastN, this.tailTokenBudget);
    if (window.summarizedMessages.length === 0) {
      return unchanged;
    }

    const summaryBody = await this.generateSummary({
      latestSummary: window.latestSummary,
      messages: window.summarizedMessages,
      model: input.model,
      runId: input.runId,
      sessionId: input.sessionId,
      signal: input.signal,
      userId: input.userId,
    });
    const content = renderContextSummary(summaryBody);
    const coveredMessageCount =
      (window.latestSummary?.contextSummary?.coveredMessageCount ?? 0) +
      window.summarizedMessages.length;
    const saved = await this.sessions.appendMessage({
      content,
      contentKind: CONTEXT_SUMMARY_KIND,
      contextSummary: {
        coveredMessageCount,
        coveredUntilMessageId: window.coveredUntilMessageId,
      },
      role: "user",
      sessionId: input.sessionId,
    });
    const summaryMessage: AgentMessage = {
      id: saved.id,
      content,
      contentKind: CONTEXT_SUMMARY_KIND,
      contextSummary: {
        coveredMessageCount,
        coveredUntilMessageId: window.coveredUntilMessageId,
      },
      createdAt: new Date().toISOString(),
      role: "user",
    };
    const messages = [...input.messages, summaryMessage];

    return {
      afterTokenEstimate: estimateProjectedCompressedHistory(messages, this.protectLastN),
      beforeTokenEstimate,
      compacted: true,
      compactedMessageCount: window.summarizedMessages.length,
      messages,
      summaryMessageId: saved.id,
    };
  }

  private async generateSummary(input: {
    latestSummary: AgentMessage | null;
    messages: AgentMessage[];
    model: string;
    runId: string;
    sessionId: string;
    signal: AbortSignal;
    userId: string;
  }): Promise<string> {
    const prompt = buildSummaryPrompt({
      latestSummary: input.latestSummary,
      summarizedMessages: input.messages,
    });
    const messages: ModelMessage[] = [
      {
        role: "system",
        content:
          "You are a context compaction worker. Produce a concise, faithful summary for a future model call. Never invent facts.",
      },
      {
        role: "user",
        content: prompt,
      },
    ];
    const context: ContextSnapshot = {
      id: `ctx_compact_${randomUUID()}`,
      messages,
      promptSections: [],
      promptTiers: emptyPromptTiers(),
      tokenEstimate: estimateModelMessages(messages),
    };
    let text = "";

    for await (const event of this.modelRouter.stream({
      context,
      maxTokens: this.maxSummaryTokens,
      model: input.model,
      runId: `${input.runId}_context_compaction`,
      sessionId: input.sessionId,
      signal: input.signal,
      thinking: "disabled",
      userId: input.userId,
    })) {
      if (event.type === "text_delta") {
        text += event.text;
      }
    }

    const summary = text.trim();
    if (!summary) {
      throw new Error("Context compression produced an empty summary");
    }

    return summary;
  }
}
