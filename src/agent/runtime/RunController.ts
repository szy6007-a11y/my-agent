import type {
  AgentEvent,
  AgentRunRequest,
  RunQueueMode,
  SequencedAgentEvent,
} from "@/agent/runtime/types";
import { isTerminalRunStatus } from "@/agent/runtime/RunEvents";
import { AgentLoop } from "@/agent/runtime/AgentLoop";
import {
  sessionRepository,
  type StoredAgentRun,
  type SessionRepository,
} from "@/agent/sessions/SessionRepository";
import { deepseekModels } from "@/lib/ai/deepseek";

function terminalRunReason(run: StoredAgentRun) {
  if (
    run.error &&
    typeof run.error === "object" &&
    "reason" in run.error &&
    typeof run.error.reason === "string"
  ) {
    return run.error.reason;
  }

  return run.status;
}

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
    const queueMode: RunQueueMode = request.queueMode ?? "followup";
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
    if (queueMode === "interrupt") {
      await this.sessions.abortOpenRunsForSession({
        reason: "interrupted_by_new_run",
        sessionId: session.id,
        userId,
      });
    }

    const run = await this.sessions.createRun({
      model,
      permissionMode,
      sessionId: session.id,
      userId,
    });

    yield* this.emit(run.id, {
      type: "run.accepted",
      queueMode,
      runId: run.id,
      sessionId: session.id,
    });

    const claimedRun = await this.sessions.waitForRunTurn({
      runId: run.id,
      signal,
      userId,
    });

    if (isTerminalRunStatus(claimedRun.status)) {
      yield* this.emit(run.id, {
        type: "run.aborted",
        runId: run.id,
        reason: terminalRunReason(claimedRun),
      });
      return;
    }

    const userMessage = await this.sessions.appendMessage({
      content: request.message,
      role: "user",
      sessionId: session.id,
    });

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
