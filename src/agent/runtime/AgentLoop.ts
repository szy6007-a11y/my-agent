import { randomUUID } from "crypto";

import {
  ContextCompressor,
  estimateAgentMessages,
} from "@/agent/context/ContextCompressor";
import { ContextEngine, promptSnapshotIsFresh } from "@/agent/context/ContextEngine";
import { ModelRouter } from "@/agent/models/ModelRouter";
import { BackgroundReviewAgent } from "@/agent/review/BackgroundReviewAgent";
import { sanitizeModelMessages } from "@/agent/runtime/PayloadSanitizer";
import {
  FinalAnswerStream,
  stripFinalAnswerProtocolTags,
} from "@/agent/runtime/FinalAnswerStream";
import {
  SYSTEM_REMINDER_CLOSE_TAG,
  applyRuntimeReminder,
  previewToolArguments,
  previewToolResult,
  stripTrustedSystemReminder,
} from "@/agent/runtime/SystemReminder";
import {
  VisibleToolCallDetector,
  type VisibleToolCallViolation,
} from "@/agent/runtime/VisibleToolCallDetector";
import {
  createDefaultHookRegistry,
  type AgentHookRegistry,
} from "@/agent/runtime/hooks";
import type {
  AgentArtifact,
  AgentEvent,
  AgentMessage,
  AskUserQuestionRequest,
  ModelMessage,
  ModelToolCall,
  PermissionMode,
  ToolRisk,
} from "@/agent/runtime/types";
import {
  sessionRepository,
  type SessionRepository,
} from "@/agent/sessions/SessionRepository";
import { FileReadState } from "@/agent/tools/FileReadState";
import { ToolRegistry } from "@/agent/tools/ToolRegistry";
import {
  parseToolArguments,
  toolError,
  type AgentTool,
  type ToolExecutionContext,
} from "@/agent/tools/types";

const DEFAULT_MAX_TOOL_ROUNDS = 90;
const MAX_TOOL_ROUNDS_ENV = "AGENT_MAX_TOOL_ROUNDS";
const MAX_TOOL_ROUNDS_UPPER_BOUND = 300;
const MAX_PROTOCOL_RECOVERY_ATTEMPTS = 1;
const RUN_CANCEL_POLL_INTERVAL_MS = 500;
const TOOL_ROUND_LIMIT_FINALIZER_PROMPT =
  "工具调用轮次已经达到上限。请停止调用工具，基于上面已经返回的工具结果给出当前可支持的最终回答；如果证据不足，请说明限制和已经查到的信息。";
const TOOL_ROUND_LIMIT_FALLBACK = "工具调用轮次达到上限，已停止继续调用工具。";
const EMPTY_ASSISTANT_FALLBACK = "我没有生成有效回复，请再试一次。";
const MISSING_FINAL_ANSWER_FALLBACK = "模型没有生成有效最终回复，请再试一次。";
const VISIBLE_TOOL_CALL_CORRECTION_MARKER = "[protocol-correction:visible_tool_call]";
const MISSING_FINAL_ANSWER_CORRECTION_MARKER = "[protocol-correction:missing_final_answer]";

export interface AgentLoopOptions {
  backgroundReview?: boolean;
  maxToolRounds?: number;
}

function normalizeMaxToolRounds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }

  return Math.min(value, MAX_TOOL_ROUNDS_UPPER_BOUND);
}

function resolveMaxToolRounds(override?: number): number {
  const fromOverride = normalizeMaxToolRounds(override);
  if (fromOverride !== null) {
    return fromOverride;
  }

  const raw = process.env[MAX_TOOL_ROUNDS_ENV]?.trim();
  if (!raw) {
    return DEFAULT_MAX_TOOL_ROUNDS;
  }

  const parsed = Number(raw);
  return normalizeMaxToolRounds(parsed) ?? DEFAULT_MAX_TOOL_ROUNDS;
}

function failedToolMessage(result: string): string | null {
  try {
    const parsed = JSON.parse(result) as { error?: unknown; success?: unknown };
    if (parsed.success === false) {
      return typeof parsed.error === "string" ? parsed.error : "Tool returned success=false";
    }
  } catch {
    return null;
  }

  return null;
}

function artifactFromToolResult(result: string): AgentArtifact | null {
  try {
    const parsed = JSON.parse(result) as { artifact?: unknown; success?: unknown };
    if (parsed.success !== true || !parsed.artifact || typeof parsed.artifact !== "object") {
      return null;
    }
    const artifact = parsed.artifact as Record<string, unknown>;
    if (
      typeof artifact.contentType !== "string" ||
      typeof artifact.downloadUrl !== "string" ||
      typeof artifact.filename !== "string" ||
      typeof artifact.id !== "string" ||
      typeof artifact.path !== "string" ||
      typeof artifact.sizeBytes !== "number"
    ) {
      return null;
    }
    return {
      contentType: artifact.contentType,
      downloadUrl: artifact.downloadUrl,
      filename: artifact.filename,
      id: artifact.id,
      path: artifact.path,
      sizeBytes: artifact.sizeBytes,
    };
  } catch {
    return null;
  }
}

function removeVisibleText(text: string, removedText: string): string {
  if (!removedText) {
    return text;
  }

  return text.endsWith(removedText) ?
      text.slice(0, -removedText.length)
    : text.replace(removedText, "");
}

function latestUserMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return messages[index];
    }
  }

  return undefined;
}

function latestUserQuestion(messages: AgentMessage[], targetMessageId?: string): string {
  const target =
    targetMessageId ?
      messages.find((message) => message.id === targetMessageId && message.role === "user")
    : latestUserMessage(messages);
  const content = target?.content ? stripTrustedSystemReminder(target.content).trim() : "";
  return content || "（未能提取到用户原问题，请基于当前上下文完成上一轮未完成任务。）";
}

function buildVisibleToolCallCorrection(toolName: string): string {
  return `上一轮模型在正文中手写了工具调用 ${toolName}，这不是有效协议。请重新处理当前请求：如果确实需要 ${toolName}，必须使用原生 tool call；如果不需要工具，必须在 <final_answer>...</final_answer> 内给出中文正文。不要在正文里输出工具 JSON、XML、函数调用文本或内部协议。`;
}

function buildMissingFinalAnswerCorrection(originalQuestion: string): string {
  return `上一轮模型没有输出文本字面量 <final_answer>...</final_answer>，因此上一轮草稿不会展示给用户。
请重新完成用户本轮真实问题，不要重新询问用户，不要丢弃已经完成的判断。
必须确保最终用户可见回答完整放在 <final_answer>...</final_answer> 内：
${originalQuestion}
如果仍需要使用工具，请先通过原生 tool call 调用对应工具；工具完成后再输出 <final_answer>...</final_answer> 和给用户看的完整中文答复。禁止在最终回答里手写工具 XML/JSON/函数调用文本。`;
}

function appendProtocolCorrection(
  content: string,
  marker: string,
  correction: string,
): string {
  if (content.includes(marker)) {
    return content;
  }

  const addition = `${marker}\n${correction}`;
  if (content.includes(SYSTEM_REMINDER_CLOSE_TAG)) {
    return content.replace(SYSTEM_REMINDER_CLOSE_TAG, `\n\n${addition}\n${SYSTEM_REMINDER_CLOSE_TAG}`);
  }

  return `${content.trimEnd()}\n\n${addition}`;
}

function appendCorrectionToLatestModelUserMessage(
  messages: ModelMessage[],
  marker: string,
  correction: string,
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && typeof message.content === "string") {
      message.content = appendProtocolCorrection(message.content, marker, correction);
      return true;
    }
  }

  return false;
}

function isContextOverflowError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    message?: unknown;
    status?: unknown;
  };
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const code = typeof candidate.code === "string" ? candidate.code : "";

  return (
    candidate.status === 413 ||
    /context(_|-)?too(_|-)?long/i.test(code) ||
    /maximum context|context length|prompt too long|context.*too long/i.test(message)
  );
}

function toolRisk(tool: AgentTool | undefined): ToolRisk {
  return tool?.risk ?? (tool?.isReadOnly ? "read" : "write");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : null;
}

function askUserQuestionRequestFromApprovalRequest(
  request: unknown,
): AskUserQuestionRequest | null {
  const requestRecord = asRecord(request);
  const details =
    requestRecord && "details" in requestRecord ? requestRecord.details : request;
  const detailRecord = asRecord(details);
  if (
    detailRecord?.kind !== "ask_user_question" ||
    !Array.isArray(detailRecord.questions)
  ) {
    return null;
  }

  return detailRecord as AskUserQuestionRequest;
}

async function toolNeedsApproval(
  tool: AgentTool | undefined,
  permissionMode: PermissionMode,
  args: unknown,
  context: ToolExecutionContext,
  toolCall: ModelToolCall,
): Promise<boolean> {
  if (!tool) {
    return false;
  }

  if (tool.requiresUserInteraction === true) {
    return true;
  }

  if (permissionMode === "bypass") {
    return false;
  }

  if (typeof tool.requiresApproval === "function") {
    try {
      return await tool.requiresApproval(args, context, toolCall);
    } catch {
      return true;
    }
  }

  if (tool.requiresApproval === true) {
    return true;
  }

  if (tool.isReadOnly === true) {
    return false;
  }

  if (permissionMode === "read-only") {
    return true;
  }

  return (
    permissionMode === "ask-on-write" ||
    permissionMode === "plan" ||
    permissionMode === "auto-safe"
  );
}

export class AgentLoop {
  constructor(
    private readonly contextEngine = new ContextEngine(),
    private readonly modelRouter = new ModelRouter(),
    private readonly sessions: SessionRepository = sessionRepository,
    private readonly backgroundReview = new BackgroundReviewAgent(modelRouter, sessions),
    private readonly contextCompressor = new ContextCompressor(modelRouter, sessions),
    private readonly hooks: AgentHookRegistry = createDefaultHookRegistry(),
    private readonly createTools: () => ToolRegistry = () => new ToolRegistry(),
    private readonly options: AgentLoopOptions = {},
  ) {}

  async *execute(input: {
    runId: string;
    sessionId: string;
    model: string;
    maxTokens: number;
    permissionMode?: PermissionMode;
    reactiveCompactionAttempted?: boolean;
    userId: string;
    userMessageId?: string;
    thinking: "enabled" | "disabled";
    signal: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    const tools = this.createTools();
    const maxToolRounds = resolveMaxToolRounds(this.options.maxToolRounds);
    const permissionMode = input.permissionMode ?? "ask-on-write";
    const readFileState = new FileReadState();
    let activeSessionId = input.sessionId;
    let toolIterations = 0;
    let lastRunStatusPollAt = 0;
    const scheduleBackgroundReview = () => {
      if (this.options.backgroundReview === false) {
        return;
      }

      void this.backgroundReview
        .maybeRun({
          model: input.model,
          runId: input.runId,
          sessionId: activeSessionId,
          thinking: input.thinking,
          toolIterations,
          userId: input.userId,
        })
        .catch((error) => {
          console.error("Background self-improvement review failed", error);
        });
    };
    const abortIfRequested = async (force = false): Promise<AgentEvent | null> => {
      if (input.signal.aborted) {
        await this.sessions.updateRunStatus(input.runId, "aborted");
        return { type: "run.aborted", runId: input.runId, reason: "client_aborted" };
      }

      const now = Date.now();
      if (!force && now - lastRunStatusPollAt < RUN_CANCEL_POLL_INTERVAL_MS) {
        return null;
      }

      lastRunStatusPollAt = now;
      const status = await this.sessions.getRunStatus(input.runId);
      return status === "aborted" ?
          { type: "run.aborted", runId: input.runId, reason: "user_cancelled" }
        : null;
    };
    const initialAbort = await abortIfRequested(true);
    if (initialAbort) {
      yield initialAbort;
      return;
    }

    await this.sessions.updateRunStatus(input.runId, "streaming_model");
    yield { type: "run.started", runId: input.runId };

    let history = await this.sessions.listMessages(activeSessionId, {
      limit: 180,
      userId: input.userId,
    });
    const preModelHookResult = await this.hooks.runPreModelCall({
      iteration: 0,
      lastUserMessage:
        history.find((message) => message.id === input.userMessageId) ??
        latestUserMessage(history),
      messages: history,
      model: input.model,
      runId: input.runId,
      sessionId: activeSessionId,
      toolNames: tools.names,
      userId: input.userId,
    });
    const reminder = applyRuntimeReminder({
      hookReminders: preModelHookResult.reminders,
      messages: history,
      model: input.model,
      runId: input.runId,
      sessionId: activeSessionId,
      targetMessageId: input.userMessageId,
      toolNames: tools.names,
      userId: input.userId,
    });

    if (reminder.changed && reminder.targetMessage) {
      await this.sessions.updateMessageContent({
        content: reminder.targetMessage.content,
        messageId: reminder.targetMessage.id,
        sessionId: activeSessionId,
        userId: input.userId,
      });
      history = reminder.messages;
      yield {
        type: "system.reminder.persisted",
        messageId: reminder.targetMessage.id,
        runId: input.runId,
        sanitized: reminder.sanitized || preModelHookResult.lastUserContentRewritten,
      };
    }
    const currentPromptSnapshot = this.contextEngine.assemblePrompt({
      availableTools: tools.names,
      model: input.model,
      provider: "deepseek",
      sessionId: activeSessionId,
      userId: input.userId,
    });
    const storedPromptSnapshot = await this.sessions.getPromptSnapshot({
      sessionId: activeSessionId,
      userId: input.userId,
    });
    const promptSnapshot =
      promptSnapshotIsFresh(storedPromptSnapshot, currentPromptSnapshot) ? storedPromptSnapshot
      : "savePromptSnapshot" in this.sessions &&
        typeof this.sessions.savePromptSnapshot === "function" ?
        await this.sessions.savePromptSnapshot({
          sessionId: activeSessionId,
          snapshot: currentPromptSnapshot,
          userId: input.userId,
        })
      : await this.sessions.savePromptSnapshotIfAbsent({
        sessionId: activeSessionId,
        snapshot: currentPromptSnapshot,
        userId: input.userId,
      });
    let effectiveHistory = history;
    try {
      const compression = await this.contextCompressor.maybeCompress({
        messages: history,
        model: input.model,
        runId: input.runId,
        sessionId: activeSessionId,
        signal: input.signal,
        userId: input.userId,
      });

      if (compression.compacted && compression.summaryMessageId) {
        await this.hooks.runPreCompact({
          reason: "proactive",
          runId: input.runId,
          sessionId: activeSessionId,
          userId: input.userId,
        });
        await this.sessions.updateRunStatus(input.runId, "compacting");
        const rotation = await this.sessions.rotateSessionForCompression({
          messages: compression.messages,
          promptSnapshot,
          runId: input.runId,
          sessionId: activeSessionId,
          userId: input.userId,
        });
        activeSessionId = rotation.session.id;
        history = rotation.messages;
        effectiveHistory = rotation.messages;
        yield {
          type: "context.compacted",
          afterTokenEstimate: compression.afterTokenEstimate,
          beforeTokenEstimate: compression.beforeTokenEstimate,
          compactedMessageCount: compression.compactedMessageCount,
          reason: "proactive",
          sessionId: activeSessionId,
          summaryMessageId: rotation.summaryMessageId ?? compression.summaryMessageId,
        };
        await this.hooks.runPostCompact({
          messagesCompacted: compression.compactedMessageCount,
          messagesRetained: rotation.messages.length,
          reason: "proactive",
          runId: input.runId,
          sessionId: activeSessionId,
          userId: input.userId,
        });
      }
    } catch (error) {
      if (input.signal.aborted) {
        await this.sessions.updateRunStatus(input.runId, "aborted");
        yield { type: "run.aborted", runId: input.runId, reason: "client_aborted" };
        return;
      }

      console.warn("Context compression skipped after failure", error);
    }

    const context = this.contextEngine.build({
      messages: effectiveHistory,
      model: input.model,
      promptSnapshot,
      provider: "deepseek",
      runtimeReminderMessageId: input.userMessageId,
      sessionId: activeSessionId,
      userId: input.userId,
      availableTools: tools.names,
    });
    yield {
      type: "context.built",
      snapshotId: context.id,
      tokenEstimate: context.tokenEstimate,
    };

    const assistantMessageId = `msg_${randomUUID()}`;
    const artifacts: AgentArtifact[] = [];
    let workingMessages: ModelMessage[] = [...context.messages];
    let visibleAssistantText = "";
    let assistantAnswerStarted = false;
    let missingFinalAnswerRecoveryAttempts = 0;
    let visibleToolCallRecoveryAttempts = 0;
    const maybeStartAnswer = (): AgentEvent | null => {
      if (assistantAnswerStarted) {
        return null;
      }

      assistantAnswerStarted = true;
      return {
        type: "assistant.answer.started",
        messageId: assistantMessageId,
        runId: input.runId,
      };
    };

    try {
      for (let round = 0; round < maxToolRounds; round += 1) {
        const roundAbort = await abortIfRequested(true);
        if (roundAbort) {
          yield roundAbort;
          return;
        }

        await this.sessions.updateRunStatus(input.runId, "streaming_model");
        let passText = "";
        let visiblePassText = "";
        let passTextMovedToReasoning = false;
        let visibleToolCallViolation: VisibleToolCallViolation | null = null;
        const finalAnswerStream = new FinalAnswerStream();
        const visibleToolCallDetector = new VisibleToolCallDetector(tools.names);
        const toolCalls: ModelToolCall[] = [];
        const sanitizedPayload = sanitizeModelMessages(workingMessages);
        if (sanitizedPayload.changed) {
          workingMessages = sanitizedPayload.messages;
          yield {
            type: "payload.sanitized",
            insertedMissingToolResults: sanitizedPayload.stats.insertedMissingToolResults,
            invalidToolArguments: sanitizedPayload.stats.invalidToolArguments,
            removedOrphanToolResults: sanitizedPayload.stats.removedOrphanToolResults,
            runId: input.runId,
          };
        }

        for await (const event of this.modelRouter.stream({
          context: {
            ...context,
            messages: workingMessages,
          },
          maxTokens: input.maxTokens,
          model: input.model,
          runId: input.runId,
          signal: input.signal,
          sessionId: activeSessionId,
          thinking: input.thinking,
          tools: tools.definitions,
          userId: input.userId,
        })) {
          const streamAbort = await abortIfRequested();
          if (streamAbort) {
            yield streamAbort;
            return;
          }

          if (event.type === "text_delta") {
            passText += event.text;

            if (!visibleToolCallViolation) {
              const violation = visibleToolCallDetector.push(event.text);
              if (violation) {
                visibleToolCallViolation = violation;
                const retractedText = visiblePassText;
                visiblePassText = "";
                if (retractedText) {
                  visibleAssistantText = removeVisibleText(visibleAssistantText, retractedText);
                  yield {
                    type: "assistant.delta.retracted",
                    messageId: assistantMessageId,
                    text: retractedText,
                  };
                }
                continue;
              }
            }

            if (visibleToolCallViolation) {
              continue;
            }

            const finalAnswerChunk = finalAnswerStream.push(event.text);
            if (finalAnswerChunk.hiddenText.trim()) {
              yield {
                type: "reasoning.delta",
                messageId: assistantMessageId,
                text: finalAnswerChunk.hiddenText,
              };
            }

            if (finalAnswerChunk.answerText) {
              const startEvent = maybeStartAnswer();
              if (startEvent) {
                yield startEvent;
              }
              visiblePassText += finalAnswerChunk.answerText;
              visibleAssistantText += finalAnswerChunk.answerText;
              yield {
                type: "assistant.delta",
                messageId: assistantMessageId,
                text: finalAnswerChunk.answerText,
              };
            }
          }

          if (event.type === "reasoning_delta") {
            yield {
              type: "reasoning.delta",
              messageId: assistantMessageId,
              text: event.text,
            };
          }

          if (event.type === "tool_calls") {
            toolCalls.push(...event.toolCalls);
          }

          if (event.type === "tool_call_started" && !passTextMovedToReasoning) {
            passTextMovedToReasoning = true;
            if (visibleToolCallViolation) {
              continue;
            }
            visibleAssistantText = removeVisibleText(visibleAssistantText, visiblePassText);
            if (visiblePassText) {
              yield {
                type: "assistant.delta.retracted",
                messageId: assistantMessageId,
                text: visiblePassText,
              };
            }
            const reasoningText = stripFinalAnswerProtocolTags(passText);
            if (reasoningText.trim()) {
              yield {
                type: "reasoning.delta",
                messageId: assistantMessageId,
                text: reasoningText,
              };
            }
          }

          if (event.type === "usage") {
            this.contextCompressor.updateFromResponse({
              promptTokens: event.inputTokens,
            });
            yield {
              type: "usage.updated",
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              totalTokens: event.totalTokens,
            };
          }
        }

        if (toolCalls.length === 0) {
          if (
            visibleToolCallViolation &&
            visibleToolCallRecoveryAttempts < MAX_PROTOCOL_RECOVERY_ATTEMPTS
          ) {
            visibleToolCallRecoveryAttempts += 1;
            if (!passTextMovedToReasoning && visiblePassText) {
              visibleAssistantText = removeVisibleText(visibleAssistantText, visiblePassText);
              yield {
                type: "assistant.delta.retracted",
                messageId: assistantMessageId,
                text: visiblePassText,
              };
            }
            const correction = buildVisibleToolCallCorrection(visibleToolCallViolation.toolName);
            const correctionTarget =
              history.find((message) => message.id === input.userMessageId) ??
              latestUserMessage(history);
            if (correctionTarget) {
              const correctedContent = appendProtocolCorrection(
                correctionTarget.content,
                VISIBLE_TOOL_CALL_CORRECTION_MARKER,
                correction,
              );
              if (correctedContent !== correctionTarget.content) {
                correctionTarget.content = correctedContent;
                await this.sessions.updateMessageContent({
                  content: correctedContent,
                  messageId: correctionTarget.id,
                  sessionId: activeSessionId,
                  userId: input.userId,
                });
              }
            }
            if (!appendCorrectionToLatestModelUserMessage(
              workingMessages,
              VISIBLE_TOOL_CALL_CORRECTION_MARKER,
              correction,
            )) {
              workingMessages.push({
                role: "user",
                content: `${VISIBLE_TOOL_CALL_CORRECTION_MARKER}\n${correction}`,
              });
            }
            yield {
              type: "protocol.recovery",
              reason: "visible_tool_call",
              retryAttempt: visibleToolCallRecoveryAttempts,
              runId: input.runId,
              toolName: visibleToolCallViolation.toolName,
            };
            continue;
          }

          if (visibleToolCallViolation) {
            const replacement = "模型输出了无效的工具调用文本，已停止展示。请重试。";
            const startEvent = maybeStartAnswer();
            if (startEvent) {
              yield startEvent;
            }
            visibleAssistantText += replacement;
            yield {
              type: "assistant.delta",
              messageId: assistantMessageId,
              text: replacement,
            };
          }

          if (!visibleToolCallViolation) {
            const answerStartedBeforeFinish = finalAnswerStream.hasStartedAnswer;
            const finalAnswerFinish = finalAnswerStream.finish();
            if (finalAnswerFinish.hiddenText.trim()) {
              yield {
                type: "reasoning.delta",
                messageId: assistantMessageId,
                text: finalAnswerFinish.hiddenText,
              };
            }

            if (
              !answerStartedBeforeFinish &&
              finalAnswerFinish.missingFinalAnswerText.trim() &&
              missingFinalAnswerRecoveryAttempts < MAX_PROTOCOL_RECOVERY_ATTEMPTS
            ) {
              missingFinalAnswerRecoveryAttempts += 1;
              const correction = buildMissingFinalAnswerCorrection(
                latestUserQuestion(history, input.userMessageId),
              );
              const unfinishedOutput = finalAnswerFinish.missingFinalAnswerText.trim();
              if (unfinishedOutput) {
                workingMessages.push({
                  role: "assistant",
                  content: unfinishedOutput,
                });
              }
              workingMessages.push({
                role: "user",
                content: `${MISSING_FINAL_ANSWER_CORRECTION_MARKER}\n${correction}`,
              });
              yield {
                type: "protocol.recovery",
                reason: "missing_final_answer",
                retryAttempt: missingFinalAnswerRecoveryAttempts,
                runId: input.runId,
              };
              continue;
            }

            if (finalAnswerFinish.answerText.trim()) {
              const startEvent = maybeStartAnswer();
              if (startEvent) {
                yield startEvent;
              }
              visibleAssistantText += finalAnswerFinish.answerText;
              yield {
                type: "assistant.delta",
                messageId: assistantMessageId,
                text: finalAnswerFinish.answerText,
              };
            }
          }

          if (!visibleAssistantText.trim()) {
            const startEvent = maybeStartAnswer();
            if (startEvent) {
              yield startEvent;
            }
            visibleAssistantText += EMPTY_ASSISTANT_FALLBACK;
            yield {
              type: "assistant.delta",
              messageId: assistantMessageId,
              text: EMPTY_ASSISTANT_FALLBACK,
            };
          }

          const postModelResponse = await this.hooks.runPostModelResponse({
            content: visibleAssistantText,
            iteration: round + 1,
            runId: input.runId,
            sessionId: activeSessionId,
            toolCalls: [],
            toolNames: tools.names,
            userId: input.userId,
          });
          if (postModelResponse.deny) {
            const replacement =
              postModelResponse.deny.userMessage ?? "模型输出未通过运行时检查，请换个问法再试。";
            if (visibleAssistantText) {
              yield {
                type: "assistant.delta.retracted",
                messageId: assistantMessageId,
                text: visibleAssistantText,
              };
            }
            visibleAssistantText = replacement;
            yield {
              type: "assistant.delta",
              messageId: assistantMessageId,
              text: replacement,
            };
          }

          const completionAbort = await abortIfRequested(true);
          if (completionAbort) {
            yield completionAbort;
            return;
          }
          const finalMessage = await this.sessions.appendMessage({
            artifacts,
            content: visibleAssistantText,
            role: "assistant",
            sessionId: activeSessionId,
          });

          await this.sessions.updateRunStatus(input.runId, "completed");
          scheduleBackgroundReview();
          await this.hooks.runMessageEnd({
            runId: input.runId,
            sessionId: activeSessionId,
            success: true,
            totalIterations: round + 1,
            userId: input.userId,
          });
          yield {
            type: "run.completed",
            finalMessageId: finalMessage.id,
            runId: input.runId,
          };
          return;
        }

        toolIterations += 1;
        const assistantToolContent =
          visibleToolCallViolation ? "" : stripFinalAnswerProtocolTags(passText);
        if (assistantToolContent.trim() && !passTextMovedToReasoning) {
          visibleAssistantText = removeVisibleText(visibleAssistantText, visiblePassText);
          if (visiblePassText) {
            yield {
              type: "assistant.delta.retracted",
              messageId: assistantMessageId,
              text: visiblePassText,
            };
          }
          yield {
            type: "reasoning.delta",
            messageId: assistantMessageId,
            text: assistantToolContent,
          };
        }

        workingMessages.push({
          role: "assistant",
          content: assistantToolContent.trim() ? assistantToolContent : null,
          toolCalls,
        });

        await this.sessions.appendMessage({
          content: assistantToolContent,
          role: "assistant",
          sessionId: activeSessionId,
          toolCalls,
        });

        await this.sessions.updateRunStatus(input.runId, "executing_tools");
        for (const toolCall of toolCalls) {
          const toolAbort = await abortIfRequested(true);
          if (toolAbort) {
            yield toolAbort;
            return;
          }

          yield {
            type: "tool.started",
            argumentsPreview: previewToolArguments(toolCall),
            runId: input.runId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          };

          const tool = tools.get(toolCall.name);
          const risk = toolRisk(tool);
          let parsedInput: unknown = {};
          try {
            parsedInput = parseToolArguments(toolCall.arguments);
          } catch {
            parsedInput = {};
          }
          const preToolResult = await this.hooks.runPreToolUse({
            input: parsedInput,
            iteration: round + 1,
            permissionMode,
            risk,
            runId: input.runId,
            sessionId: activeSessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            userId: input.userId,
          });
          let effectiveToolCall = toolCall;
          if (preToolResult.rewrite !== undefined && preToolResult.rewrite !== parsedInput) {
            effectiveToolCall = {
              ...toolCall,
              arguments: JSON.stringify(preToolResult.rewrite),
            };
            parsedInput = preToolResult.rewrite;
          }

          let result: string;
          let durationMs = 0;
          const toolSideEvents: AgentEvent[] = [];
          const toolContext: ToolExecutionContext = {
            emitEvent: (event) => {
              toolSideEvents.push(event);
            },
            model: input.model,
            permissionMode,
            readFileState,
            runId: input.runId,
            signal: input.signal,
            sessionId: activeSessionId,
            sessions: this.sessions,
            userId: input.userId,
          };

          if (preToolResult.deny) {
            result = toolError(`工具调用被策略拦截：${preToolResult.deny.reason}`);
          } else {
            const prepared = await tools.prepare(effectiveToolCall, toolContext);
            if (!prepared.ok) {
              parsedInput = prepared.args ?? parsedInput;
              result = prepared.result;
            } else {
              parsedInput = prepared.args;
              const preparedRisk = toolRisk(prepared.tool);
              if (
                await toolNeedsApproval(
                  prepared.tool,
                  permissionMode,
                  prepared.args,
                  toolContext,
                  prepared.toolCall,
                )
              ) {
                await this.sessions.updateRunStatus(input.runId, "waiting_approval");
                const defaultReason =
                  permissionMode === "read-only" ?
                    "当前权限模式为 read-only，写类工具需要用户确认。"
                  : "当前工具会产生写入或长期副作用，需要用户确认。";
                const approvalDetails = prepared.tool.buildApproval ?
                  await prepared.tool.buildApproval(prepared.args, toolContext, prepared.toolCall)
                : {};
                const reason = approvalDetails.reason ?? defaultReason;
                const approvalRequest = {
                  argumentsPreview: previewToolArguments(prepared.toolCall),
                  permissionMode,
                  risk: preparedRisk,
                  toolArguments: prepared.args,
                  toolCallId: prepared.toolCall.id,
                  toolName: prepared.toolCall.name,
                  ...(approvalDetails.request ? { details: approvalDetails.request } : {}),
                };
                const approval = await this.sessions.createToolApproval({
                  reason,
                  request: approvalRequest,
                  risk: preparedRisk,
                  runId: input.runId,
                  sessionId: activeSessionId,
                  toolCallId: prepared.toolCall.id,
                  toolName: prepared.toolCall.name,
                  userId: input.userId,
                });
                const questionRequest =
                  askUserQuestionRequestFromApprovalRequest(approvalRequest);
                yield {
                  type: "tool.approval.required",
                  approvalId: approval.id,
                  reason,
                  request: approvalRequest,
                  risk: preparedRisk,
                  runId: input.runId,
                  toolCallId: prepared.toolCall.id,
                  toolName: prepared.toolCall.name,
                };
                if (questionRequest) {
                  yield {
                    type: "tool.question.required",
                    message: reason,
                    questionId: approval.id,
                    questions: questionRequest.questions,
                    request: questionRequest,
                    runId: input.runId,
                    toolCallId: prepared.toolCall.id,
                    toolName: prepared.toolCall.name,
                  };
                }
                yield {
                  type: "tool.confirmation.required",
                  confirmationId: approval.id,
                  message: reason,
                  runId: input.runId,
                  toolCallId: prepared.toolCall.id,
                  toolName: prepared.toolCall.name,
                };
                const decision = await this.sessions.waitForToolApproval({
                  approvalId: approval.id,
                  signal: input.signal,
                  userId: input.userId,
                });
                const approvalAbort = await abortIfRequested(true);
                if (approvalAbort) {
                  yield approvalAbort;
                  return;
                }
                const approved = decision.status === "approved";
                yield {
                  type: "tool.approval.resolved",
                  approvalId: approval.id,
                  approved,
                  runId: input.runId,
                  status: decision.status,
                  toolCallId: prepared.toolCall.id,
                  toolName: prepared.toolCall.name,
                };
                await this.sessions.updateRunStatus(input.runId, "executing_tools");
                if (approved) {
                  const startedAt = Date.now();
                  if (prepared.tool.applyApprovalDecision) {
                    try {
                      const approvedArgs = await prepared.tool.applyApprovalDecision(
                        prepared.args,
                        decision,
                        toolContext,
                        prepared.toolCall,
                      );
                      parsedInput = approvedArgs;
                      result = await tools.executePrepared(
                        { ...prepared, args: approvedArgs },
                        toolContext,
                      );
                    } catch (error) {
                      result = toolError(
                        error instanceof Error ?
                          error.message
                        : "Tool approval payload could not be applied.",
                      );
                    }
                  } else {
                    result = await tools.executePrepared(prepared, toolContext);
                  }
                  durationMs = Date.now() - startedAt;
                } else {
                  const deniedReason =
                    decision.status === "expired" ?
                      "工具审批超时，已取消执行。"
                    : "用户拒绝了工具执行请求。";
                  result = toolError(deniedReason, {
                    approvalId: approval.id,
                    approvalStatus: decision.status,
                    requiresApproval: true,
                  });
                }
              } else {
                const startedAt = Date.now();
                result = await tools.executePrepared(prepared, toolContext);
                durationMs = Date.now() - startedAt;
              }
            }
          }
          const failure = failedToolMessage(result);

          workingMessages.push({
            role: "tool",
            content: result,
            toolCallId: effectiveToolCall.id,
          });
          await this.sessions.appendMessage({
            content: result,
            role: "tool",
            sessionId: activeSessionId,
            toolCallId: effectiveToolCall.id,
            toolName: effectiveToolCall.name,
          });
          await this.hooks.runPostToolUse({
            durationMs,
            input: parsedInput,
            iteration: round + 1,
            ok: !failure,
            output: result,
            runId: input.runId,
            sessionId: activeSessionId,
            toolCallId: effectiveToolCall.id,
            toolName: effectiveToolCall.name,
            userId: input.userId,
          });

          for (const event of toolSideEvents) {
            yield event;
          }

          if (failure) {
            yield {
              type: "tool.failed",
              durationMs,
              runId: input.runId,
              toolCallId: effectiveToolCall.id,
              toolName: effectiveToolCall.name,
              error: failure,
            };
          } else {
            const artifact = artifactFromToolResult(result);
            if (artifact) {
              artifacts.push(artifact);
              yield {
                type: "artifact.created",
                artifact,
                runId: input.runId,
                toolCallId: effectiveToolCall.id,
                toolName: effectiveToolCall.name,
              };
            }
            yield {
              type: "tool.completed",
              durationMs,
              resultPreview: previewToolResult(result),
              runId: input.runId,
              toolCallId: effectiveToolCall.id,
              toolName: effectiveToolCall.name,
            };
          }
        }
      }

      await this.sessions.updateRunStatus(input.runId, "finalizing");
      const finalizerAnswerStream = new FinalAnswerStream();
      let finalizerAnswerStarted = false;
      const sanitizedFinalizerPayload = sanitizeModelMessages(workingMessages);
      if (sanitizedFinalizerPayload.changed) {
        workingMessages = sanitizedFinalizerPayload.messages;
        yield {
          type: "payload.sanitized",
          insertedMissingToolResults: sanitizedFinalizerPayload.stats.insertedMissingToolResults,
          invalidToolArguments: sanitizedFinalizerPayload.stats.invalidToolArguments,
          removedOrphanToolResults: sanitizedFinalizerPayload.stats.removedOrphanToolResults,
          runId: input.runId,
        };
      }
      for await (const event of this.modelRouter.stream({
        context: {
          ...context,
          messages: [
            ...workingMessages,
            {
              role: "user",
              content: TOOL_ROUND_LIMIT_FINALIZER_PROMPT,
            },
          ],
        },
        maxTokens: input.maxTokens,
        model: input.model,
        runId: input.runId,
        signal: input.signal,
        sessionId: activeSessionId,
        thinking: input.thinking,
        tools: [],
        userId: input.userId,
      })) {
        const finalizerAbort = await abortIfRequested();
        if (finalizerAbort) {
          yield finalizerAbort;
          return;
        }

        if (event.type === "text_delta") {
          const finalAnswerChunk = finalizerAnswerStream.push(event.text);
          finalizerAnswerStarted ||= finalAnswerChunk.answerStarted;
          if (finalAnswerChunk.hiddenText.trim()) {
            yield {
              type: "reasoning.delta",
              messageId: assistantMessageId,
              text: finalAnswerChunk.hiddenText,
            };
          }
          if (finalAnswerChunk.answerText) {
            const startEvent = maybeStartAnswer();
            if (startEvent) {
              yield startEvent;
            }
            visibleAssistantText += finalAnswerChunk.answerText;
            yield {
              type: "assistant.delta",
              messageId: assistantMessageId,
              text: finalAnswerChunk.answerText,
            };
          }
        }

        if (event.type === "reasoning_delta") {
          yield {
            type: "reasoning.delta",
            messageId: assistantMessageId,
            text: event.text,
          };
        }

        if (event.type === "usage") {
          this.contextCompressor.updateFromResponse({
            promptTokens: event.inputTokens,
          });
          yield {
            type: "usage.updated",
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            totalTokens: event.totalTokens,
          };
        }
      }

      const finalizerAnswerFinish = finalizerAnswerStream.finish();
      if (finalizerAnswerFinish.hiddenText.trim()) {
        yield {
          type: "reasoning.delta",
          messageId: assistantMessageId,
          text: finalizerAnswerFinish.hiddenText,
        };
      }
      if (finalizerAnswerFinish.answerText.trim()) {
        const startEvent = maybeStartAnswer();
        if (startEvent) {
          yield startEvent;
        }
        visibleAssistantText += finalizerAnswerFinish.answerText;
        yield {
          type: "assistant.delta",
          messageId: assistantMessageId,
          text: finalizerAnswerFinish.answerText,
        };
      }

      if (!visibleAssistantText.trim()) {
        const fallbackDelta =
          finalizerAnswerStarted || !finalizerAnswerFinish.missingFinalAnswerText.trim() ?
            TOOL_ROUND_LIMIT_FALLBACK
          : MISSING_FINAL_ANSWER_FALLBACK;
        const startEvent = maybeStartAnswer();
        if (startEvent) {
          yield startEvent;
        }
        visibleAssistantText += fallbackDelta;
        yield {
          type: "assistant.delta",
          messageId: assistantMessageId,
          text: fallbackDelta,
        };
      }

      const finalizerPostModelResponse = await this.hooks.runPostModelResponse({
        content: visibleAssistantText,
        iteration: maxToolRounds + 1,
        runId: input.runId,
        sessionId: activeSessionId,
        toolCalls: [],
        toolNames: tools.names,
        userId: input.userId,
      });
      if (finalizerPostModelResponse.deny) {
        const replacement =
          finalizerPostModelResponse.deny.userMessage ??
          "模型输出未通过运行时检查，请换个问法再试。";
        if (visibleAssistantText) {
          yield {
            type: "assistant.delta.retracted",
            messageId: assistantMessageId,
            text: visibleAssistantText,
          };
        }
        visibleAssistantText = replacement;
        yield {
          type: "assistant.delta",
          messageId: assistantMessageId,
          text: replacement,
        };
      }

      const completionAbort = await abortIfRequested(true);
      if (completionAbort) {
        yield completionAbort;
        return;
      }
      const finalMessage = await this.sessions.appendMessage({
        artifacts,
        content: visibleAssistantText,
        role: "assistant",
        sessionId: activeSessionId,
      });
      await this.sessions.updateRunStatus(input.runId, "completed");
      scheduleBackgroundReview();
      await this.hooks.runMessageEnd({
        runId: input.runId,
        sessionId: activeSessionId,
        success: true,
        totalIterations: maxToolRounds + 1,
        userId: input.userId,
      });
      yield {
        type: "run.completed",
        finalMessageId: finalMessage.id,
        runId: input.runId,
      };
    } catch (error) {
      if (input.signal.aborted) {
        await this.sessions.updateRunStatus(input.runId, "aborted");
        yield { type: "run.aborted", runId: input.runId, reason: "client_aborted" };
        return;
      }

      if (isContextOverflowError(error) && !input.reactiveCompactionAttempted) {
        await this.sessions.updateRunStatus(input.runId, "compacting");
        const latestHistory = await this.sessions.listMessages(activeSessionId, {
          limit: 180,
          userId: input.userId,
        });
        const beforeTokenEstimate = estimateAgentMessages(latestHistory);
        yield {
          type: "context.compaction.started",
          beforeTokenEstimate,
          reason: "reactive",
        };
        await this.hooks.runPreCompact({
          reason: "reactive",
          runId: input.runId,
          sessionId: activeSessionId,
          userId: input.userId,
        });

        try {
          const compression = await this.contextCompressor.maybeCompress({
            force: true,
            messages: latestHistory,
            model: input.model,
            runId: input.runId,
            sessionId: activeSessionId,
            signal: input.signal,
            userId: input.userId,
          });

          if (compression.compacted && compression.summaryMessageId) {
            const rotation = await this.sessions.rotateSessionForCompression({
              messages: compression.messages,
              promptSnapshot,
              runId: input.runId,
              sessionId: activeSessionId,
              userId: input.userId,
            });
            activeSessionId = rotation.session.id;
            yield {
              type: "context.compacted",
              afterTokenEstimate: compression.afterTokenEstimate,
              beforeTokenEstimate: compression.beforeTokenEstimate,
              compactedMessageCount: compression.compactedMessageCount,
              reason: "reactive",
              sessionId: activeSessionId,
              summaryMessageId: rotation.summaryMessageId ?? compression.summaryMessageId,
            };
            await this.hooks.runPostCompact({
              messagesCompacted: compression.compactedMessageCount,
              messagesRetained: rotation.messages.length,
              reason: "reactive",
              runId: input.runId,
              sessionId: activeSessionId,
              userId: input.userId,
            });
            yield {
              type: "protocol.recovery",
              reason: "context_too_long",
              retryAttempt: 1,
              runId: input.runId,
            };

            for await (const retryEvent of this.execute({
              ...input,
              reactiveCompactionAttempted: true,
              sessionId: activeSessionId,
            })) {
              if (retryEvent.type !== "run.started") {
                yield retryEvent;
              }
            }
            return;
          }
        } catch (compressionError) {
          console.warn("Reactive context compression failed", compressionError);
        }
      }

      const message = error instanceof Error ? error.message : "Unknown agent error";
      await this.sessions.updateRunStatus(input.runId, "failed", { message });
      await this.hooks.runMessageEnd({
        error,
        runId: input.runId,
        sessionId: activeSessionId,
        success: false,
        totalIterations: 0,
        userId: input.userId,
      });
      yield { type: "run.failed", runId: input.runId, error: message };
    }
  }
}
