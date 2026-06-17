import type { AgentEvent, AgentRunRequest } from "@/agent/runtime/types";
import { AgentLoop } from "@/agent/runtime/AgentLoop";
import {
  sessionRepository,
  type SessionRepository,
} from "@/agent/sessions/SessionRepository";
import { deepseekModels } from "@/lib/ai/deepseek";

const LOCAL_USER_ID = "local-dev-user";

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
  ): AsyncGenerator<AgentEvent> {
    const model = request.model ?? deepseekModels.default;
    const permissionMode = request.permissionMode ?? "ask-on-write";
    const thinking = request.thinking ?? "disabled";
    const maxTokens = request.maxTokens ?? 1024;

    const session =
      request.sessionId ?
        { id: request.sessionId }
      : await this.sessions.createSession({
          title: titleFromMessage(request.message),
          userId: LOCAL_USER_ID,
        });

    await this.sessions.touchSession(session.id);
    await this.sessions.appendMessage({
      content: request.message,
      role: "user",
      sessionId: session.id,
    });

    const run = await this.sessions.createRun({
      model,
      permissionMode,
      sessionId: session.id,
      userId: LOCAL_USER_ID,
    });

    yield* this.emit(run.id, { type: "run.accepted", runId: run.id, sessionId: session.id });

    for await (const event of this.loop.execute({
      maxTokens,
      model,
      runId: run.id,
      sessionId: session.id,
      signal,
      thinking,
    })) {
      yield* this.emit(run.id, event);
    }
  }

  private async *emit(runId: string, event: AgentEvent): AsyncGenerator<AgentEvent> {
    await this.sessions.appendRunEvent(runId, event);
    yield event;
  }
}
