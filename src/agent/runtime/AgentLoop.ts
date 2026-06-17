import { randomUUID } from "crypto";

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
      userId: input.userId,
    });
    const context = this.contextEngine.build({
      messages: history,
      model: input.model,
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

      const fallback =
        visibleAssistantText.trim() ?
          `${visibleAssistantText}\n\n（工具调用轮次达到上限，已停止继续调用工具。）`
        : "工具调用轮次达到上限，已停止继续调用工具。";
      const finalMessage = await this.sessions.appendMessage({
        content: fallback,
        role: "assistant",
        sessionId: input.sessionId,
      });
      await this.sessions.updateRunStatus(input.runId, "completed");
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
