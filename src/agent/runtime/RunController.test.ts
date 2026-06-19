import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent, RunStatus } from "@/agent/runtime/types";
import type {
  SessionRepository,
  StoredAgentRun,
} from "@/agent/sessions/SessionRepository";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

class FakeLoop {
  readonly executeCalls: Array<{ runId: string; userMessageId?: string }> = [];

  async *execute(input: { runId: string; userMessageId?: string }) {
    this.executeCalls.push(input);
    yield { type: "run.started", runId: input.runId } satisfies AgentEvent;
    yield {
      type: "run.completed",
      finalMessageId: "msg_final",
      runId: input.runId,
    } satisfies AgentEvent;
  }
}

class FakeRunRepository {
  readonly actions: string[] = [];
  readonly messages: Array<{ content: string; role: string; sessionId: string }> = [];
  readonly runEvents: Array<{ event: AgentEvent; runId: string }> = [];
  readonly runInputs: Array<{ sessionId: string }> = [];
  private nextEventSeq = 1;
  private releaseTurn!: () => void;
  private readonly turnPromise = new Promise<void>((resolve) => {
    this.releaseTurn = resolve;
  });

  abortOpenCalls: Array<{ reason?: string; sessionId: string; userId: string }> = [];
  resolvedSessionId: string | null = null;
  waitCalls: Array<{ runId: string; userId: string }> = [];

  async getSessionForUser(sessionId: string) {
    return { id: sessionId, title: "现有会话" };
  }

  async resolveCompressionHead(input: { sessionId: string }) {
    return { id: this.resolvedSessionId ?? input.sessionId, title: "现有会话" };
  }

  async createSession() {
    this.actions.push("createSession");
    return { id: "sess_new" };
  }

  async touchSession() {
    this.actions.push("touchSession");
  }

  async abortOpenRunsForSession(input: {
    reason?: string;
    sessionId: string;
    userId: string;
  }) {
    this.actions.push("abortOpenRunsForSession");
    this.abortOpenCalls.push(input);
    return [];
  }

  async createRun(input: { sessionId: string }) {
    this.actions.push("createRun");
    this.runInputs.push(input);
    return { id: "run_1" };
  }

  async appendRunEvent(runId: string, event: AgentEvent) {
    this.actions.push(`appendRunEvent:${event.type}`);
    this.runEvents.push({ event, runId });
    return this.nextEventSeq++;
  }

  async waitForRunTurn(input: { runId: string; userId: string }) {
    this.actions.push("waitForRunTurn");
    this.waitCalls.push(input);
    await this.turnPromise;
    return storedRun({
      id: input.runId,
      status: "preparing",
    });
  }

  async appendMessage(input: { content: string; role: string; sessionId: string }) {
    this.actions.push("appendMessage");
    this.messages.push(input);
    return { id: "msg_user" };
  }

  releaseQueuedRun() {
    this.releaseTurn();
  }
}

function storedRun(overrides: Partial<StoredAgentRun> = {}): StoredAgentRun {
  return {
    id: "run_1",
    createdAt: new Date(0).toISOString(),
    endedAt: null,
    error: null,
    model: "deepseek-v4-flash",
    permissionMode: "ask-on-write",
    sessionId: "sess_1",
    startedAt: null,
    status: "queued" satisfies RunStatus,
    ...overrides,
  };
}

async function drain<T>(events: AsyncGenerator<T>) {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

test("RunController emits acceptance before queued user messages enter history", async () => {
  const { RunController } = await import("@/agent/runtime/RunController");
  const repository = new FakeRunRepository();
  const loop = new FakeLoop();
  const controller = new RunController(
    repository as unknown as SessionRepository,
    loop as never,
  );
  const iterator = controller.startRun(
    {
      message: "排队的后续问题",
      sessionId: "sess_1",
    },
    new AbortController().signal,
    "usr_1",
  );

  const accepted = await iterator.next();

  assert.equal(accepted.value?.type, "run.accepted");
  assert.equal(accepted.value?.seq, 1);
  assert.equal(repository.messages.length, 0);

  repository.releaseQueuedRun();
  const rest = await drain(iterator);

  assert.deepEqual(repository.messages, [
    {
      content: "排队的后续问题",
      role: "user",
      sessionId: "sess_1",
    },
  ]);
  assert.equal(loop.executeCalls[0]?.userMessageId, "msg_user");
  assert.deepEqual(
    rest.map((event) => event.type),
    ["run.started", "run.completed"],
  );
});

test("RunController interrupts open runs before creating the next run", async () => {
  const { RunController } = await import("@/agent/runtime/RunController");
  const repository = new FakeRunRepository();
  const controller = new RunController(
    repository as unknown as SessionRepository,
    new FakeLoop() as never,
  );

  repository.releaseQueuedRun();
  await drain(
    controller.startRun(
      {
        message: "立即切换任务",
        queueMode: "interrupt",
        sessionId: "sess_1",
      },
      new AbortController().signal,
      "usr_1",
    ),
  );

  assert.deepEqual(repository.abortOpenCalls, [
    {
      reason: "interrupted_by_new_run",
      sessionId: "sess_1",
      userId: "usr_1",
    },
  ]);
  assert.ok(
    repository.actions.indexOf("abortOpenRunsForSession") <
      repository.actions.indexOf("createRun"),
  );
});

test("RunController resumes compression descendants before creating a run", async () => {
  const { RunController } = await import("@/agent/runtime/RunController");
  const repository = new FakeRunRepository();
  repository.resolvedSessionId = "sess_child";
  const loop = new FakeLoop();
  const controller = new RunController(
    repository as unknown as SessionRepository,
    loop as never,
  );

  repository.releaseQueuedRun();
  const events = await drain(
    controller.startRun(
      {
        message: "继续旧会话",
        sessionId: "sess_parent",
      },
      new AbortController().signal,
      "usr_1",
    ),
  );

  assert.equal(events[0]?.type, "run.accepted");
  assert.equal(
    events[0]?.type === "run.accepted" ? events[0].sessionId : null,
    "sess_child",
  );
  assert.equal(repository.runInputs[0]?.sessionId, "sess_child");
  assert.deepEqual(repository.messages, [
    {
      content: "继续旧会话",
      role: "user",
      sessionId: "sess_child",
    },
  ]);
  assert.equal(loop.executeCalls[0]?.runId, "run_1");
});
