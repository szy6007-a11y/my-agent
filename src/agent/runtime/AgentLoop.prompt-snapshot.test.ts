import assert from "node:assert/strict";
import test from "node:test";

import type { PromptAssembler, PromptAssembly } from "@/agent/context/PromptAssembler";
import type { ModelStreamInput } from "@/agent/models/ProviderAdapter";
import type { ModelRouter } from "@/agent/models/ModelRouter";
import type { AgentEvent, AgentMessage, RunStatus } from "@/agent/runtime/types";
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
    return makePrompt(`prompt-${this.count}`);
  }
}

class FakeModelRouter {
  readonly systemPrompts: string[] = [];

  async *stream(input: ModelStreamInput) {
    this.systemPrompts.push(input.context.messages[0]?.content ?? "");
    yield { type: "text_delta" as const, text: "ok" };
  }
}

class FakeSessionRepository {
  readonly messages: AgentMessage[] = [];
  readonly statuses: RunStatus[] = [];
  promptSnapshot: PromptAssembly | null = null;
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

  async updateRunStatus(_runId: string, status: RunStatus): Promise<void> {
    this.statuses.push(status);
  }

  async appendMessage(input: {
    content: string;
    role: AgentMessage["role"];
    sessionId: string;
  }): Promise<{ id: string }> {
    const message: AgentMessage = {
      id: `msg_${this.messages.length + 1}`,
      content: input.content,
      createdAt: new Date(0).toISOString(),
      role: input.role,
    };
    this.messages.push(message);
    return { id: message.id };
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

  assert.equal(promptAssembler.count, 1);
  assert.equal(sessions.savedSnapshots, 1);
  assert.deepEqual(modelRouter.systemPrompts, ["prompt-1", "prompt-1"]);
});
