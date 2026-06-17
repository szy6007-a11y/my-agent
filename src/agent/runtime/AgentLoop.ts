import { randomUUID } from "crypto";

import { ContextEngine } from "@/agent/context/ContextEngine";
import { ModelRouter } from "@/agent/models/ModelRouter";
import type { AgentEvent } from "@/agent/runtime/types";
import {
  sessionRepository,
  type SessionRepository,
} from "@/agent/sessions/SessionRepository";

export class AgentLoop {
  constructor(
    private readonly contextEngine = new ContextEngine(),
    private readonly modelRouter = new ModelRouter(),
    private readonly sessions: SessionRepository = sessionRepository,
  ) {}

  async *execute(input: {
    runId: string;
    sessionId: string;
    model: string;
    maxTokens: number;
    thinking: "enabled" | "disabled";
    signal: AbortSignal;
  }): AsyncGenerator<AgentEvent> {
    await this.sessions.updateRunStatus(input.runId, "streaming_model");
    yield { type: "run.started", runId: input.runId };

    const history = await this.sessions.listMessages(input.sessionId);
    const context = this.contextEngine.build({ messages: history });
    yield {
      type: "context.built",
      snapshotId: context.id,
      tokenEstimate: context.tokenEstimate,
    };

    const assistantMessageId = `msg_${randomUUID()}`;
    let assistantText = "";

    try {
      for await (const event of this.modelRouter.stream({
        context,
        maxTokens: input.maxTokens,
        model: input.model,
        signal: input.signal,
        thinking: input.thinking,
      })) {
        if (input.signal.aborted) {
          await this.sessions.updateRunStatus(input.runId, "aborted");
          yield { type: "run.aborted", runId: input.runId, reason: "client_aborted" };
          return;
        }

        if (event.type === "text_delta") {
          assistantText += event.text;
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

      const finalMessage = await this.sessions.appendMessage({
        content: assistantText || "我没有生成有效回复，请再试一次。",
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
