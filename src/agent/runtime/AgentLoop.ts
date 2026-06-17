import { randomUUID } from "crypto";

import { ContextCompressor } from "@/agent/context/ContextCompressor";
import { ContextEngine } from "@/agent/context/ContextEngine";
import { ModelRouter } from "@/agent/models/ModelRouter";
import { BackgroundReviewAgent } from "@/agent/review/BackgroundReviewAgent";
import type { AgentEvent, ModelMessage, ModelToolCall } from "@/agent/runtime/types";
import {
  sessionRepository,
  type SessionRepository,
} from "@/agent/sessions/SessionRepository";
import { ToolRegistry } from "@/agent/tools/ToolRegistry";

const MAX_TOOL_ROUNDS = 6;
const TOOL_ROUND_LIMIT_FINALIZER_PROMPT =
  "工具调用轮次已经达到上限。请停止调用工具，基于上面已经返回的工具结果给出当前可支持的最终回答；如果证据不足，请说明限制和已经查到的信息。";
const TOOL_ROUND_LIMIT_FALLBACK = "工具调用轮次达到上限，已停止继续调用工具。";

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

export class AgentLoop {
  constructor(
    private readonly contextEngine = new ContextEngine(),
    private readonly modelRouter = new ModelRouter(),
    private readonly sessions: SessionRepository = sessionRepository,
    private readonly backgroundReview = new BackgroundReviewAgent(modelRouter, sessions),
    private readonly contextCompressor = new ContextCompressor(modelRouter, sessions),
  ) {}

  async *execute(input: {
    runId: string;
    sessionId: string;
    model: string;
    maxTokens: number;
    userId: string;
    thinking: "enabled" | "disabled";
    signal: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    const tools = new ToolRegistry();
    await this.sessions.updateRunStatus(input.runId, "streaming_model");
    yield { type: "run.started", runId: input.runId };

    const history = await this.sessions.listMessages(input.sessionId, {
      limit: 180,
      userId: input.userId,
    });
    const storedPromptSnapshot = await this.sessions.getPromptSnapshot({
      sessionId: input.sessionId,
      userId: input.userId,
    });
    const promptSnapshot =
      storedPromptSnapshot ??
      (await this.sessions.savePromptSnapshotIfAbsent({
        sessionId: input.sessionId,
        snapshot: this.contextEngine.assemblePrompt({
          availableTools: tools.names,
          model: input.model,
          provider: "deepseek",
          sessionId: input.sessionId,
          userId: input.userId,
        }),
        userId: input.userId,
      }));
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
        effectiveHistory = compression.messages;
        await this.sessions.updateRunStatus(input.runId, "compacting");
        yield {
          type: "context.compacted",
          afterTokenEstimate: compression.afterTokenEstimate,
          beforeTokenEstimate: compression.beforeTokenEstimate,
          compactedMessageCount: compression.compactedMessageCount,
          summaryMessageId: compression.summaryMessageId,
        };
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
    const workingMessages: ModelMessage[] = [...context.messages];
    let visibleAssistantText = "";

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        await this.sessions.updateRunStatus(input.runId, "streaming_model");
        let passText = "";
        const toolCalls: ModelToolCall[] = [];

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
          if (input.signal.aborted) {
            await this.sessions.updateRunStatus(input.runId, "aborted");
            yield { type: "run.aborted", runId: input.runId, reason: "client_aborted" };
            return;
          }

          if (event.type === "text_delta") {
            passText += event.text;
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

          if (event.type === "tool_calls") {
            toolCalls.push(...event.toolCalls);
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
          const finalMessage = await this.sessions.appendMessage({
            content: visibleAssistantText || "我没有生成有效回复，请再试一次。",
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
          yield {
            type: "run.completed",
            finalMessageId: finalMessage.id,
            runId: input.runId,
          };
          return;
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
          if (input.signal.aborted) {
            await this.sessions.updateRunStatus(input.runId, "aborted");
            yield { type: "run.aborted", runId: input.runId, reason: "client_aborted" };
            return;
          }

          yield {
            type: "tool.started",
            runId: input.runId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          };

          const result = await tools.execute(toolCall, {
            runId: input.runId,
            signal: input.signal,
            sessionId: input.sessionId,
            sessions: this.sessions,
            userId: input.userId,
          });
          const failure = failedToolMessage(result);

          workingMessages.push({
            role: "tool",
            content: result,
            toolCallId: toolCall.id,
          });
          await this.sessions.appendMessage({
            content: result,
            role: "tool",
            sessionId: input.sessionId,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });

          if (failure) {
            yield {
              type: "tool.failed",
              runId: input.runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              error: failure,
            };
          } else {
            yield {
              type: "tool.completed",
              runId: input.runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
            };
          }
        }
      }

      await this.sessions.updateRunStatus(input.runId, "finalizing");
      let finalizerText = "";
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
        if (input.signal.aborted) {
          await this.sessions.updateRunStatus(input.runId, "aborted");
          yield { type: "run.aborted", runId: input.runId, reason: "client_aborted" };
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

      const finalMessage = await this.sessions.appendMessage({
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

      const message = error instanceof Error ? error.message : "Unknown agent error";
      await this.sessions.updateRunStatus(input.runId, "failed", { message });
      yield { type: "run.failed", runId: input.runId, error: message };
    }
  }
}
