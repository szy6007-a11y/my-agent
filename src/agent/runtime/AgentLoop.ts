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
  applyRuntimeReminder,
  previewToolArguments,
  previewToolResult,
} from "@/agent/runtime/SystemReminder";
import {
  createDefaultHookRegistry,
  type AgentHookRegistry,
} from "@/agent/runtime/hooks";
import type {
  AgentArtifact,
  AgentEvent,
  AgentMessage,
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
} from "@/agent/tools/types";

const MAX_TOOL_ROUNDS = 6;
const MAX_PROTOCOL_RECOVERY_ATTEMPTS = 1;
const RUN_CANCEL_POLL_INTERVAL_MS = 500;
const TOOL_ROUND_LIMIT_FINALIZER_PROMPT =
  "工具调用轮次已经达到上限。请停止调用工具，基于上面已经返回的工具结果给出当前可支持的最终回答；如果证据不足，请说明限制和已经查到的信息。";
const TOOL_ROUND_LIMIT_FALLBACK = "工具调用轮次达到上限，已停止继续调用工具。";
const EMPTY_ASSISTANT_FALLBACK = "我没有生成有效回复，请再试一次。";

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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectVisibleToolProtocolViolation(
  text: string,
  toolNames: string[],
): string | null {
  if (!text.trim()) {
    return null;
  }

  for (const toolName of toolNames) {
    const escaped = escapeRegExp(toolName);
    const patterns = [
      new RegExp(`<\\s*${escaped}\\b`, "i"),
      new RegExp(`<\\s*tool\\b[^>]*>\\s*${escaped}\\b`, "i"),
      new RegExp(`\\b${escaped}\\s*\\(\\s*[{\\[]`, "i"),
    ];

    if (patterns.some((pattern) => pattern.test(text))) {
      return toolName;
    }
  }

  return null;
}

function buildProtocolCorrection(toolName: string): string {
  return `上一轮模型在正文中手写了工具调用 ${toolName}，这不是有效协议。请重新处理当前请求：如果确实需要 ${toolName}，必须使用原生 tool call；如果不需要工具，请直接给出中文正文。不要在正文里输出工具 JSON、XML、函数调用文本或内部协议。`;
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

function toolNeedsApproval(tool: AgentTool | undefined, permissionMode: PermissionMode): boolean {
  if (!tool) {
    return false;
  }

  if (permissionMode === "bypass") {
    return false;
  }

  if (tool.requiresApproval === true) {
    return true;
  }

  if (tool.isReadOnly === true) {
    return false;
  }

  return (
    permissionMode === "read-only" ||
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
    const permissionMode = input.permissionMode ?? "ask-on-write";
    const readFileState = new FileReadState();
    let lastRunStatusPollAt = 0;
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

    let history = await this.sessions.listMessages(input.sessionId, {
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
      sessionId: input.sessionId,
      toolNames: tools.names,
      userId: input.userId,
    });
    const reminder = applyRuntimeReminder({
      hookReminders: preModelHookResult.reminders,
      messages: history,
      model: input.model,
      runId: input.runId,
      sessionId: input.sessionId,
      targetMessageId: input.userMessageId,
      toolNames: tools.names,
      userId: input.userId,
    });

    if (reminder.changed && reminder.targetMessage) {
      await this.sessions.updateMessageContent({
        content: reminder.targetMessage.content,
        messageId: reminder.targetMessage.id,
        sessionId: input.sessionId,
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
      sessionId: input.sessionId,
      userId: input.userId,
    });
    const storedPromptSnapshot = await this.sessions.getPromptSnapshot({
      sessionId: input.sessionId,
      userId: input.userId,
    });
    const promptSnapshot =
      promptSnapshotIsFresh(storedPromptSnapshot, currentPromptSnapshot) ? storedPromptSnapshot
      : "savePromptSnapshot" in this.sessions &&
        typeof this.sessions.savePromptSnapshot === "function" ?
        await this.sessions.savePromptSnapshot({
          sessionId: input.sessionId,
          snapshot: currentPromptSnapshot,
          userId: input.userId,
        })
      : await this.sessions.savePromptSnapshotIfAbsent({
        sessionId: input.sessionId,
        snapshot: currentPromptSnapshot,
        userId: input.userId,
      });
    let effectiveHistory = history;
    try {
      const compression = await this.contextCompressor.maybeCompress({
        messages: history,
        model: input.model,
        runId: input.runId,
        sessionId: input.sessionId,
        signal: input.signal,
        userId: input.userId,
      });

      if (compression.compacted && compression.summaryMessageId) {
        await this.hooks.runPreCompact({
          reason: "proactive",
          runId: input.runId,
          sessionId: input.sessionId,
          userId: input.userId,
        });
        effectiveHistory = compression.messages;
        await this.sessions.updateRunStatus(input.runId, "compacting");
        yield {
          type: "context.compacted",
          afterTokenEstimate: compression.afterTokenEstimate,
          beforeTokenEstimate: compression.beforeTokenEstimate,
          compactedMessageCount: compression.compactedMessageCount,
          reason: "proactive",
          summaryMessageId: compression.summaryMessageId,
        };
        await this.hooks.runPostCompact({
          messagesCompacted: compression.compactedMessageCount,
          messagesRetained: compression.messages.length - compression.compactedMessageCount,
          reason: "proactive",
          runId: input.runId,
          sessionId: input.sessionId,
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
      sessionId: input.sessionId,
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
    let protocolRecoveryAttempts = 0;

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const roundAbort = await abortIfRequested(true);
        if (roundAbort) {
          yield roundAbort;
          return;
        }

        await this.sessions.updateRunStatus(input.runId, "streaming_model");
        let passText = "";
        let visiblePassText = "";
        let passTextMovedToReasoning = false;
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
          sessionId: input.sessionId,
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
            if (passTextMovedToReasoning) {
              yield {
                type: "reasoning.delta",
                messageId: assistantMessageId,
                text: event.text,
              };
            } else {
              visiblePassText += event.text;
              visibleAssistantText += event.text;
              yield {
                type: "assistant.delta",
                messageId: assistantMessageId,
                text: event.text,
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
            visibleAssistantText = removeVisibleText(visibleAssistantText, visiblePassText);
            if (visiblePassText) {
              yield {
                type: "assistant.delta.retracted",
                messageId: assistantMessageId,
                text: visiblePassText,
              };
            }
            if (passText) {
              yield {
                type: "reasoning.delta",
                messageId: assistantMessageId,
                text: passText,
              };
            }
          }

          if (event.type === "usage") {
            yield {
              type: "usage.updated",
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              totalTokens: event.totalTokens,
            };
          }
        }

        if (toolCalls.length === 0) {
          const visibleToolCall = detectVisibleToolProtocolViolation(passText, tools.names);
          if (
            visibleToolCall &&
            protocolRecoveryAttempts < MAX_PROTOCOL_RECOVERY_ATTEMPTS
          ) {
            protocolRecoveryAttempts += 1;
            if (!passTextMovedToReasoning && visiblePassText) {
              visibleAssistantText = removeVisibleText(visibleAssistantText, visiblePassText);
              yield {
                type: "assistant.delta.retracted",
                messageId: assistantMessageId,
                text: visiblePassText,
              };
            }
            workingMessages.push({
              role: "user",
              content: buildProtocolCorrection(visibleToolCall),
            });
            yield {
              type: "protocol.recovery",
              reason: "visible_tool_call",
              retryAttempt: protocolRecoveryAttempts,
              runId: input.runId,
              toolName: visibleToolCall,
            };
            continue;
          }

          if (passTextMovedToReasoning && passText.trim()) {
            visibleAssistantText += passText;
            yield {
              type: "assistant.delta",
              messageId: assistantMessageId,
              text: passText,
            };
          }

          if (!passText.trim() && !visibleAssistantText.trim()) {
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
            sessionId: input.sessionId,
            toolCalls: [],
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
            sessionId: input.sessionId,
          });

          await this.sessions.updateRunStatus(input.runId, "completed");
          void this.backgroundReview
            .maybeRun({
              model: input.model,
              runId: input.runId,
              sessionId: input.sessionId,
              thinking: input.thinking,
              userId: input.userId,
            })
            .catch((error) => {
              console.error("Background memory review failed", error);
            });
          await this.hooks.runMessageEnd({
            runId: input.runId,
            sessionId: input.sessionId,
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

        if (passText && !passTextMovedToReasoning) {
          visibleAssistantText = removeVisibleText(visibleAssistantText, visiblePassText);
          yield {
            type: "assistant.delta.retracted",
            messageId: assistantMessageId,
            text: visiblePassText,
          };
          yield {
            type: "reasoning.delta",
            messageId: assistantMessageId,
            text: passText,
          };
        }

        workingMessages.push({
          role: "assistant",
          content: passText.trim() ? passText : null,
          toolCalls,
        });

        await this.sessions.appendMessage({
          content: passText,
          role: "assistant",
          sessionId: input.sessionId,
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
            sessionId: input.sessionId,
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
          const toolContext = {
            permissionMode,
            readFileState,
            runId: input.runId,
            signal: input.signal,
            sessionId: input.sessionId,
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
              if (toolNeedsApproval(prepared.tool, permissionMode)) {
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
                  sessionId: input.sessionId,
                  toolCallId: prepared.toolCall.id,
                  toolName: prepared.toolCall.name,
                  userId: input.userId,
                });
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
                  result = await tools.executePrepared(prepared, toolContext);
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
            sessionId: input.sessionId,
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
            sessionId: input.sessionId,
            toolCallId: effectiveToolCall.id,
            toolName: effectiveToolCall.name,
            userId: input.userId,
          });

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
      let finalizerText = "";
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
        sessionId: input.sessionId,
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
          finalizerText += event.text;
          visibleAssistantText += event.text;
          yield {
            type: "assistant.delta",
            messageId: assistantMessageId,
            text: event.text,
          };
        }

        if (event.type === "reasoning_delta") {
          yield {
            type: "reasoning.delta",
            messageId: assistantMessageId,
            text: event.text,
          };
        }

        if (event.type === "usage") {
          yield {
            type: "usage.updated",
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            totalTokens: event.totalTokens,
          };
        }
      }

      if (!finalizerText.trim()) {
        const fallbackDelta =
          visibleAssistantText.trim() ?
            `\n\n（${TOOL_ROUND_LIMIT_FALLBACK}）`
          : TOOL_ROUND_LIMIT_FALLBACK;
        visibleAssistantText += fallbackDelta;
        yield {
          type: "assistant.delta",
          messageId: assistantMessageId,
          text: fallbackDelta,
        };
      }

      const finalizerPostModelResponse = await this.hooks.runPostModelResponse({
        content: visibleAssistantText,
        iteration: MAX_TOOL_ROUNDS + 1,
        runId: input.runId,
        sessionId: input.sessionId,
        toolCalls: [],
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
        sessionId: input.sessionId,
      });
      await this.sessions.updateRunStatus(input.runId, "completed");
      void this.backgroundReview
        .maybeRun({
          model: input.model,
          runId: input.runId,
          sessionId: input.sessionId,
          thinking: input.thinking,
          userId: input.userId,
        })
        .catch((error) => {
          console.error("Background memory review failed", error);
        });
      await this.hooks.runMessageEnd({
        runId: input.runId,
        sessionId: input.sessionId,
        success: true,
        totalIterations: MAX_TOOL_ROUNDS + 1,
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
        const latestHistory = await this.sessions.listMessages(input.sessionId, {
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
          sessionId: input.sessionId,
          userId: input.userId,
        });

        try {
          const compression = await this.contextCompressor.maybeCompress({
            force: true,
            messages: latestHistory,
            model: input.model,
            runId: input.runId,
            sessionId: input.sessionId,
            signal: input.signal,
            userId: input.userId,
          });

          if (compression.compacted && compression.summaryMessageId) {
            yield {
              type: "context.compacted",
              afterTokenEstimate: compression.afterTokenEstimate,
              beforeTokenEstimate: compression.beforeTokenEstimate,
              compactedMessageCount: compression.compactedMessageCount,
              reason: "reactive",
              summaryMessageId: compression.summaryMessageId,
            };
            await this.hooks.runPostCompact({
              messagesCompacted: compression.compactedMessageCount,
              messagesRetained: compression.messages.length - compression.compactedMessageCount,
              reason: "reactive",
              runId: input.runId,
              sessionId: input.sessionId,
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
        sessionId: input.sessionId,
        success: false,
        totalIterations: 0,
        userId: input.userId,
      });
      yield { type: "run.failed", runId: input.runId, error: message };
    }
  }
}
