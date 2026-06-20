import assert from "node:assert/strict";
import test from "node:test";

import type { PromptAssembler, PromptAssembly } from "@/agent/context/PromptAssembler";
import type { ModelStreamInput } from "@/agent/models/ProviderAdapter";
import type { ModelRouter } from "@/agent/models/ModelRouter";
import type {
  AgentEvent,
  AgentMessage,
  ModelToolCall,
  RunStatus,
} from "@/agent/runtime/types";
import type { BackgroundReviewAgent } from "@/agent/review/BackgroundReviewAgent";
import type { SessionRepository } from "@/agent/sessions/SessionRepository";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

function makePrompt(prompt: string): PromptAssembly {
  return {
    prompt,
    sections: [],
    tiers: {
      context: "<project_context_layer status=\"empty\">\n</project_context_layer>",
      stable: "<stable_context status=\"empty\">\n</stable_context>",
      volatile: "<volatile_context status=\"empty\">\n</volatile_context>",
    },
  };
}

class CountingPromptAssembler {
  count = 0;

  assemble(): PromptAssembly {
    this.count += 1;
    return {
      ...makePrompt(`prompt-${this.count}`),
      metadata: {
        availableToolsHash: "tools-v1",
        promptVersion: "test",
        skillIndexHash: "skills-v1",
      },
      signature: "stable-signature",
    };
  }
}

class FakeModelRouter {
  readonly systemPrompts: string[] = [];

  async *stream(input: ModelStreamInput) {
    this.systemPrompts.push(input.context.messages[0]?.content ?? "");
    yield { type: "text_delta" as const, text: "ok" };
  }
}

class ToolLoopThenFinalModelRouter {
  readonly calls: Array<{ lastUserMessage: string; toolCount: number }> = [];

  async *stream(input: ModelStreamInput) {
    const lastUserMessage =
      [...input.context.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const toolCount = input.tools?.length ?? 0;
    this.calls.push({ lastUserMessage, toolCount });

    if (toolCount > 0) {
      yield {
        type: "tool_calls" as const,
        toolCalls: [
          {
            arguments: "{}",
            id: `call_${this.calls.length}`,
            name: "unknown_tool",
          },
        ],
      };
      return;
    }

    yield { type: "text_delta" as const, text: "基于已返回的搜索结果，这是最终回答。" };
  }
}

class ToolNarrationThenFinalModelRouter {
  readonly calls: number[] = [];

  async *stream(input: ModelStreamInput) {
    const toolCount = input.tools?.length ?? 0;
    this.calls.push(toolCount);

    if (this.calls.length === 1) {
      yield { type: "text_delta" as const, text: "Let me search first." };
      yield { type: "tool_call_started" as const };
      yield {
        type: "tool_calls" as const,
        toolCalls: [
          {
            arguments: "{}",
            id: "call_search",
            name: "unknown_tool",
          },
        ],
      };
      return;
    }

    yield { type: "text_delta" as const, text: "<final_answer>这是" };
    yield { type: "text_delta" as const, text: "最终" };
    yield { type: "text_delta" as const, text: "回答。</final_answer>" };
  }
}

class ProactiveCompressionStub {
  updateFromResponse(): void {
    return;
  }

  async maybeCompress(input: { messages: AgentMessage[] }) {
    const summary: AgentMessage = {
      id: "summary_tmp",
      content: "## Context Summary\nCompressed historical state.",
      contentKind: "context_summary",
      contextSummary: {
        coveredMessageCount: Math.max(1, input.messages.length - 1),
        coveredUntilMessageId: input.messages.at(-2)?.id ?? input.messages[0]?.id,
      },
      createdAt: new Date(0).toISOString(),
      role: "user",
    };

    return {
      afterTokenEstimate: 10,
      beforeTokenEstimate: 100,
      compacted: true,
      compactedMessageCount: Math.max(1, input.messages.length - 1),
      messages: [summary, ...input.messages.slice(-1)],
      summaryMessageId: summary.id,
    };
  }
}

class FakeSessionRepository {
  readonly appendCalls: Array<{ role: AgentMessage["role"]; sessionId: string }> = [];
  readonly messages: AgentMessage[] = [];
  readonly rotations: Array<{ runId?: string; sessionId: string }> = [];
  readonly statuses: RunStatus[] = [];
  promptSnapshot: PromptAssembly | null = null;
  runStatus: RunStatus | null = null;
  savedSnapshots = 0;

  async getPromptSnapshot(): Promise<PromptAssembly | null> {
    return this.promptSnapshot;
  }

  async savePromptSnapshotIfAbsent(input: { snapshot: PromptAssembly }): Promise<PromptAssembly> {
    if (!this.promptSnapshot) {
      this.promptSnapshot = input.snapshot;
      this.savedSnapshots += 1;
    }

    return this.promptSnapshot;
  }

  async listMessages(): Promise<AgentMessage[]> {
    return this.messages;
  }

  async updateMessageContent(input: { content: string; messageId: string }): Promise<void> {
    const message = this.messages.find((item) => item.id === input.messageId);
    if (message) {
      message.content = input.content;
    }
  }

  async updateRunStatus(_runId: string, status: RunStatus): Promise<void> {
    this.statuses.push(status);
  }

  async getRunStatus(): Promise<RunStatus | null> {
    return this.runStatus;
  }

  async appendMessage(input: {
    content: string;
    role: AgentMessage["role"];
    sessionId: string;
    toolCallId?: string;
    toolCalls?: ModelToolCall[];
    toolName?: string;
  }): Promise<{ id: string }> {
    this.appendCalls.push({ role: input.role, sessionId: input.sessionId });
    const message: AgentMessage = {
      id: `msg_${this.messages.length + 1}`,
      content: input.content,
      createdAt: new Date(0).toISOString(),
      role: input.role,
      toolCallId: input.toolCallId,
      toolCalls: input.toolCalls,
      toolName: input.toolName,
    };
    this.messages.push(message);
    return { id: message.id };
  }

  async rotateSessionForCompression(input: {
    messages: AgentMessage[];
    runId?: string;
    sessionId: string;
  }) {
    this.rotations.push({
      runId: input.runId,
      sessionId: input.sessionId,
    });
    const childMessages = input.messages.map((message, index) => ({
      ...message,
      id: `child_msg_${index + 1}`,
    }));
    this.messages.splice(0, this.messages.length, ...childMessages);

    return {
      messages: childMessages,
      session: {
        createdAt: new Date(0).toISOString(),
        endedAt: null,
        endReason: null,
        id: "sess_child",
        messageCount: childMessages.length,
        parentSessionId: input.sessionId,
        status: "active",
        title: "child",
        updatedAt: new Date(0).toISOString(),
      },
      summaryMessageId: childMessages[0]?.id ?? null,
    };
  }
}

class NoopBackgroundReview {
  async maybeRun(): Promise<void> {
    return;
  }
}

async function drain(events: AsyncGenerator<AgentEvent>) {
  const result: AgentEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

function visibleAssistantText(events: AgentEvent[]) {
  let text = "";

  for (const event of events) {
    if (event.type === "assistant.delta") {
      text += event.text;
    }

    if (event.type === "assistant.delta.retracted") {
      text =
        text.endsWith(event.text) ?
          text.slice(0, -event.text.length)
        : text.replace(event.text, "");
    }
  }

  return text;
}

test("AgentLoop freezes the session prompt snapshot across runs", async () => {
  const [{ ContextEngine }, { AgentLoop }] = await Promise.all([
    import("@/agent/context/ContextEngine"),
    import("@/agent/runtime/AgentLoop"),
  ]);
  const promptAssembler = new CountingPromptAssembler();
  const contextEngine = new ContextEngine(promptAssembler as unknown as PromptAssembler);
  const modelRouter = new FakeModelRouter();
  const sessions = new FakeSessionRepository();
  const loop = new AgentLoop(
    contextEngine,
    modelRouter as unknown as ModelRouter,
    sessions as unknown as SessionRepository,
    new NoopBackgroundReview() as unknown as BackgroundReviewAgent,
  );
  const signal = new AbortController().signal;

  await drain(
    loop.execute({
      maxTokens: 128,
      model: "deepseek-v4-flash",
      runId: "run_1",
      sessionId: "sess_1",
      signal,
      thinking: "disabled",
      userId: "usr_1",
    }),
  );
  await drain(
    loop.execute({
      maxTokens: 128,
      model: "deepseek-v4-flash",
      runId: "run_2",
      sessionId: "sess_1",
      signal,
      thinking: "disabled",
      userId: "usr_1",
    }),
  );

  assert.equal(promptAssembler.count, 2);
  assert.equal(sessions.savedSnapshots, 1);
  assert.deepEqual(modelRouter.systemPrompts, ["prompt-1", "prompt-1"]);
});

test("AgentLoop rotates to a compression child session before continuing the run", async () => {
  const [{ ContextEngine }, { AgentLoop }] = await Promise.all([
    import("@/agent/context/ContextEngine"),
    import("@/agent/runtime/AgentLoop"),
  ]);
  const contextEngine = new ContextEngine({
    assemble: () => makePrompt("compression-rotate-prompt"),
  } as unknown as PromptAssembler);
  const modelRouter = new FakeModelRouter();
  const sessions = new FakeSessionRepository();
  sessions.messages.push(
    {
      id: "msg_old",
      content: "old history",
      createdAt: new Date(0).toISOString(),
      role: "user",
    },
    {
      id: "msg_current",
      content: "current turn",
      createdAt: new Date(1).toISOString(),
      role: "user",
    },
  );
  const loop = new AgentLoop(
    contextEngine,
    modelRouter as unknown as ModelRouter,
    sessions as unknown as SessionRepository,
    new NoopBackgroundReview() as unknown as BackgroundReviewAgent,
    new ProactiveCompressionStub() as never,
  );

  const events = await drain(
    loop.execute({
      maxTokens: 128,
      model: "deepseek-v4-flash",
      runId: "run_rotate",
      sessionId: "sess_parent",
      signal: new AbortController().signal,
      thinking: "disabled",
      userId: "usr_1",
    }),
  );
  const compacted = events.find(
    (event): event is Extract<AgentEvent, { type: "context.compacted" }> =>
      event.type === "context.compacted",
  );

  assert.equal(compacted?.summaryMessageId, "child_msg_1");
  assert.equal(compacted?.sessionId, "sess_child");
  assert.deepEqual(sessions.rotations, [{ runId: "run_rotate", sessionId: "sess_parent" }]);
  assert.equal(sessions.appendCalls.at(-1)?.role, "assistant");
  assert.equal(sessions.appendCalls.at(-1)?.sessionId, "sess_child");
});

test("AgentLoop finalizes without tools after tool round limit", async () => {
  const [{ ContextEngine }, { AgentLoop }] = await Promise.all([
    import("@/agent/context/ContextEngine"),
    import("@/agent/runtime/AgentLoop"),
  ]);
  const contextEngine = new ContextEngine({
    assemble: () => makePrompt("tool-loop-prompt"),
  } as unknown as PromptAssembler);
  const modelRouter = new ToolLoopThenFinalModelRouter();
  const sessions = new FakeSessionRepository();
  const loop = new AgentLoop(
    contextEngine,
    modelRouter as unknown as ModelRouter,
    sessions as unknown as SessionRepository,
    new NoopBackgroundReview() as unknown as BackgroundReviewAgent,
    undefined,
    undefined,
    undefined,
    { maxToolRounds: 6 },
  );

  const events = await drain(
    loop.execute({
      maxTokens: 128,
      model: "deepseek-v4-flash",
      runId: "run_tool_limit",
      sessionId: "sess_tool_limit",
      signal: new AbortController().signal,
      thinking: "disabled",
      userId: "usr_1",
    }),
  );
  const deltas = events
    .filter((event): event is Extract<AgentEvent, { type: "assistant.delta" }> =>
      event.type === "assistant.delta",
    )
    .map((event) => event.text)
    .join("");

  assert.equal(modelRouter.calls.length, 7);
  assert.equal(modelRouter.calls.at(-1)?.toolCount, 0);
  assert.match(modelRouter.calls.at(-1)?.lastUserMessage ?? "", /工具调用轮次已经达到上限/);
  assert.equal(deltas, "基于已返回的搜索结果，这是最终回答。");
  assert.equal(sessions.messages.at(-1)?.content, "基于已返回的搜索结果，这是最终回答。");
  assert.ok(sessions.statuses.includes("finalizing"));
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("AgentLoop keeps pre-tool narration out of the visible stream while streaming the final answer", async () => {
  const [{ ContextEngine }, { AgentLoop }] = await Promise.all([
    import("@/agent/context/ContextEngine"),
    import("@/agent/runtime/AgentLoop"),
  ]);
  const contextEngine = new ContextEngine({
    assemble: () => makePrompt("pre-tool-narration-prompt"),
  } as unknown as PromptAssembler);
  const modelRouter = new ToolNarrationThenFinalModelRouter();
  const sessions = new FakeSessionRepository();
  const loop = new AgentLoop(
    contextEngine,
    modelRouter as unknown as ModelRouter,
    sessions as unknown as SessionRepository,
    new NoopBackgroundReview() as unknown as BackgroundReviewAgent,
  );

  const events = await drain(
    loop.execute({
      maxTokens: 128,
      model: "deepseek-v4-flash",
      runId: "run_pre_tool_narration",
      sessionId: "sess_pre_tool_narration",
      signal: new AbortController().signal,
      thinking: "disabled",
      userId: "usr_1",
    }),
  );
  const deltaTexts = events
    .filter((event): event is Extract<AgentEvent, { type: "assistant.delta" }> =>
      event.type === "assistant.delta",
    )
    .map((event) => event.text);
  const retractedTexts = events
    .filter(
      (event): event is Extract<AgentEvent, { type: "assistant.delta.retracted" }> =>
        event.type === "assistant.delta.retracted",
    )
    .map((event) => event.text);
  const reasoningTexts = events
    .filter((event): event is Extract<AgentEvent, { type: "reasoning.delta" }> =>
      event.type === "reasoning.delta",
    )
    .map((event) => event.text);
  const answerStartIndex = events.findIndex(
    (event) => event.type === "assistant.answer.started",
  );
  const firstDeltaIndex = events.findIndex((event) => event.type === "assistant.delta");
  const firstToolStartIndex = events.findIndex((event) => event.type === "tool.started");
  const toolCallMessage = sessions.messages.find(
    (message) => message.role === "assistant" && message.toolCalls?.length,
  );

  assert.equal(modelRouter.calls.length, 2);
  assert.ok(modelRouter.calls.every((toolCount) => toolCount > 0));
  assert.deepEqual(deltaTexts, ["这是", "最终", "回答。"]);
  assert.deepEqual(retractedTexts, []);
  assert.deepEqual(reasoningTexts, ["Let me search first."]);
  assert.ok(firstToolStartIndex >= 0);
  assert.ok(answerStartIndex > firstToolStartIndex);
  assert.ok(firstDeltaIndex > answerStartIndex);
  assert.equal(visibleAssistantText(events), "这是最终回答。");
  assert.equal(sessions.messages.at(-1)?.content, "这是最终回答。");
  assert.equal(toolCallMessage?.content, "Let me search first.");
});
