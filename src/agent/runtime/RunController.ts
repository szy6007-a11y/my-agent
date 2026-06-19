import type {
  AgentEvent,
  AgentRunRequest,
  SequencedAgentEvent,
} from "@/agent/runtime/types";
import { AgentLoop } from "@/agent/runtime/AgentLoop";
import {
  sessionRepository,
  type SessionRepository,
} from "@/agent/sessions/SessionRepository";
import { deepseekModels } from "@/lib/ai/deepseek";

function titleFromMessage(message: string) {
  const title = message.trim().replace(/\s+/g, " ").slice(0, 32);
  return title || "新会话";
}

export class RunController {
  constructor(
    private readonly sessions: SessionRepository = sessionRepository,
    private readonly loop = new AgentLoop(),
  ) {}

  async *startRun(
    request: AgentRunRequest,
    signal: AbortSignal,
    userId: string,
  ): AsyncGenerator<SequencedAgentEvent> {
    const model = request.model ?? deepseekModels.default;
    const permissionMode = request.permissionMode ?? "ask-on-write";
    const thinking = request.thinking ?? "disabled";
    const maxTokens = request.maxTokens ?? 1024;

    const session =
      request.sessionId ?
        await this.sessions.getSessionForUser(request.sessionId, userId)
      : await this.sessions.createSession({
          title: titleFromMessage(request.message),
          userId,
        });

    if (!session) {
      throw new Error("Session not found");
    }

    await this.sessions.touchSession(session.id, userId);
    const userMessage = await this.sessions.appendMessage({
      content: request.message,
      role: "user",
      sessionId: session.id,
    });

    const run = await this.sessions.createRun({
      model,
      permissionMode,
      sessionId: session.id,
      userId,
    });

    yield* this.emit(run.id, { type: "run.accepted", runId: run.id, sessionId: session.id });

    for await (const event of this.loop.execute({
      maxTokens,
      model,
      permissionMode,
      runId: run.id,
      sessionId: session.id,
      signal,
      thinking,
      userMessageId: userMessage.id,
      userId,
    })) {
      yield* this.emit(run.id, event);
    }
  }

  private async *emit(
    runId: string,
    event: AgentEvent,
  ): AsyncGenerator<SequencedAgentEvent> {
    const seq = await this.sessions.appendRunEvent(runId, event);
    if (seq === null) {
      throw new Error(`Run event could not be persisted: ${event.type}`);
    }

    yield {
      ...event,
      seq,
    };
  }
}
