import assert from "node:assert/strict";
import test from "node:test";

import type { ModelStreamInput } from "@/agent/models/ProviderAdapter";
import type { ModelRouter } from "@/agent/models/ModelRouter";
import type { AgentMessage } from "@/agent/runtime/types";
import type { PromptAssembly } from "@/agent/context/PromptAssembler";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

function makeMessage(index: number, content = "message ".repeat(80)): AgentMessage {
  return {
    id: `msg_${index}`,
    content: `${content}${index}`,
    createdAt: new Date(index * 1000).toISOString(),
    role: index % 2 === 0 ? "assistant" : "user",
  };
}

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

class FakeModelRouter {
  readonly prompts: string[] = [];

  async *stream(input: ModelStreamInput) {
    this.prompts.push(input.context.messages.map((message) => message.content).join("\n\n"));
    yield {
      type: "text_delta" as const,
      text: "## Historical Task Snapshot\nSummarized older work.",
    };
  }
}

test("ContextCompressor returns Hermes-style active summary and tail messages", async () => {
  const [{ ContextCompressor }, { CONTEXT_SUMMARY_HEADING, CONTEXT_SUMMARY_KIND }] =
    await Promise.all([
      import("@/agent/context/ContextCompressor"),
      import("@/agent/context/ContextSummary"),
    ]);
  const modelRouter = new FakeModelRouter();
  const compressor = new ContextCompressor(
    modelRouter as unknown as ModelRouter,
    undefined,
    {
      contextWindowTokens: 100,
      minimumContextTokens: 1,
      protectLastN: 2,
      thresholdPercent: 0.1,
    },
  );

  const result = await compressor.maybeCompress({
    messages: Array.from({ length: 6 }, (_, index) => makeMessage(index + 1)),
    model: "deepseek-test",
    runId: "run_1",
    sessionId: "sess_1",
    signal: new AbortController().signal,
    userId: "usr_1",
  });

  assert.equal(result.compacted, true);
  assert.equal(result.compactedMessageCount, 3);
  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[0].contentKind, CONTEXT_SUMMARY_KIND);
  assert.deepEqual(result.messages[0].contextSummary, {
    coveredMessageCount: 3,
    coveredUntilMessageId: "msg_3",
  });
  assert.equal(result.messages[0].role, "user");
  assert.ok(result.messages[0].content.startsWith(CONTEXT_SUMMARY_HEADING));
  assert.deepEqual(
    result.messages.slice(1).map((message) => message.id),
    ["msg_4", "msg_5", "msg_6"],
  );
});

test("ContextCompressor folds the previous compacted summary into the next summary", async () => {
  const [{ ContextCompressor }, { CONTEXT_SUMMARY_KIND, renderContextSummary }] =
    await Promise.all([
      import("@/agent/context/ContextCompressor"),
      import("@/agent/context/ContextSummary"),
  ]);
  const modelRouter = new FakeModelRouter();
  const compressor = new ContextCompressor(
    modelRouter as unknown as ModelRouter,
    undefined,
    {
      contextWindowTokens: 100,
      minimumContextTokens: 1,
      protectLastN: 2,
      thresholdPercent: 0.1,
    },
  );
  const previousSummary: AgentMessage = {
    id: "summary_0",
    content: renderContextSummary("Previous durable facts."),
    contentKind: CONTEXT_SUMMARY_KIND,
    contextSummary: {
      coveredMessageCount: 1,
      coveredUntilMessageId: "msg_1",
    },
    createdAt: new Date(0).toISOString(),
    role: "user",
  };

  const result = await compressor.maybeCompress({
    messages: [
      previousSummary,
      ...Array.from({ length: 6 }, (_, index) => makeMessage(index + 1)),
    ],
    model: "deepseek-test",
    runId: "run_2",
    sessionId: "sess_1",
    signal: new AbortController().signal,
    userId: "usr_1",
  });

  assert.deepEqual(result.messages[0].contextSummary, {
    coveredMessageCount: 3,
    coveredUntilMessageId: "msg_3",
  });
  assert.match(modelRouter.prompts[0], /Previous durable facts/);
  assert.doesNotMatch(modelRouter.prompts[0], /message message .*6/s);
});

test("ContextCompressor follows the Hermes threshold floor before compacting", async () => {
  const [{ ContextCompressor }] = await Promise.all([
    import("@/agent/context/ContextCompressor"),
  ]);
  const modelRouter = new FakeModelRouter();
  const compressor = new ContextCompressor(
    modelRouter as unknown as ModelRouter,
  );

  const result = await compressor.maybeCompress({
    messages: Array.from({ length: 12 }, (_, index) =>
      makeMessage(index + 1, "not near the model context yet ".repeat(100)),
    ),
    model: "deepseek-test",
    runId: "run_3",
    sessionId: "sess_1",
    signal: new AbortController().signal,
    userId: "usr_1",
  });

  assert.equal(result.compacted, false);
  assert.equal(modelRouter.prompts.length, 0);
});

test("ContextEngine includes latest compacted summary plus uncovered live messages", async () => {
  const [{ ContextEngine }, { CONTEXT_SUMMARY_KIND, renderContextSummary }] = await Promise.all([
    import("@/agent/context/ContextEngine"),
    import("@/agent/context/ContextSummary"),
  ]);
  const engine = new ContextEngine();
  const oldSummary: AgentMessage = {
    id: "summary_old",
    content: renderContextSummary("old summary"),
    contentKind: CONTEXT_SUMMARY_KIND,
    createdAt: new Date(0).toISOString(),
    role: "user",
  };
  const latestSummary: AgentMessage = {
    id: "summary_latest",
    content: renderContextSummary("latest summary"),
    contentKind: CONTEXT_SUMMARY_KIND,
    contextSummary: {
      coveredMessageCount: 5,
      coveredUntilMessageId: "msg_5",
    },
    createdAt: new Date(1).toISOString(),
    role: "user",
  };
  const tail = Array.from({ length: 30 }, (_, index) => makeMessage(index + 1, "tail "));

  const context = engine.build({
    messages: [oldSummary, makeMessage(100), latestSummary, ...tail],
    promptSnapshot: makePrompt("static system prompt"),
  });

  assert.equal(context.messages[0].content, "static system prompt");
  assert.equal(context.messages[1].content, latestSummary.content);
  assert.equal(context.messages.length, 27);
  assert.equal(context.messages[2].content, tail[5].content);
  assert.equal(context.messages.at(-1)?.content, tail.at(-1)?.content);
  assert.ok(context.messages.every((message) => message.content !== oldSummary.content));
});

test("ContextEngine preserves live tool call history for the model payload", async () => {
  const { ContextEngine } = await import("@/agent/context/ContextEngine");
  const engine = new ContextEngine();

  const context = engine.build({
    messages: [
      {
        id: "msg_user",
        content: "查一下 release 信息",
        createdAt: new Date(0).toISOString(),
        role: "user",
      },
      {
        id: "msg_assistant_tool",
        content: "",
        createdAt: new Date(1).toISOString(),
        role: "assistant",
        toolCalls: [
          {
            arguments: JSON.stringify({ query: "release 信息" }),
            id: "call_search",
            name: "web_search",
          },
        ],
      },
      {
        id: "msg_tool",
        content: JSON.stringify({ results: [{ title: "release note" }] }),
        createdAt: new Date(2).toISOString(),
        role: "tool",
        toolCallId: "call_search",
        toolName: "web_search",
      },
      {
        id: "msg_assistant_final",
        content: "查到了 release note。",
        createdAt: new Date(3).toISOString(),
        role: "assistant",
      },
    ],
    promptSnapshot: makePrompt("static system prompt"),
  });

  assert.deepEqual(context.messages.slice(1), [
    {
      role: "user",
      content: "查一下 release 信息",
    },
    {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          arguments: JSON.stringify({ query: "release 信息" }),
          id: "call_search",
          name: "web_search",
        },
      ],
    },
    {
      role: "tool",
      content: JSON.stringify({ results: [{ title: "release note" }] }),
      toolCallId: "call_search",
    },
    {
      role: "assistant",
      content: "查到了 release note。",
    },
  ]);
  assert.ok(context.tokenEstimate > 0);
});

test("ContextEngine refreshes stale model lines from session prompt snapshots", async () => {
  const { ContextEngine } = await import("@/agent/context/ContextEngine");
  const engine = new ContextEngine();
  const snapshot: PromptAssembly = {
    prompt:
      "<system_prompt>\n<volatile_context>\nModel: deepseek-v4-flash\n</volatile_context>\n</system_prompt>",
    sections: [
      {
        content: "Provider: deepseek\nModel: deepseek-v4-flash",
        source: "runtime",
        tag: "environment_context",
        tier: "volatile",
      },
    ],
    tiers: {
      context: "<project_context_layer status=\"empty\">\n</project_context_layer>",
      stable: "<stable_context status=\"empty\">\n</stable_context>",
      volatile:
        "<volatile_context>\n<environment_context source=\"runtime\">\nModel: deepseek-v4-flash\n</environment_context>\n</volatile_context>",
    },
  };

  const context = engine.build({
    messages: [],
    model: "deepseek-v4-pro",
    promptSnapshot: snapshot,
  });

  assert.match(context.messages[0].content ?? "", /Model: deepseek-v4-pro/);
  assert.doesNotMatch(context.messages[0].content ?? "", /deepseek-v4-flash/);
  assert.equal(
    context.promptSections.find((section) => section.tag === "environment_context")?.content,
    "Provider: deepseek\nModel: deepseek-v4-pro",
  );
});

test("ContextEngine strips stale runtime reminders from historical user messages", async () => {
  const { ContextEngine } = await import("@/agent/context/ContextEngine");
  const {
    SYSTEM_REMINDER_CLOSE_TAG,
    SYSTEM_REMINDER_OPEN_TAG,
    TRUSTED_SYSTEM_REMINDER_SENTINEL,
  } = await import("@/shared/runtime-reminder");
  const engine = new ContextEngine();
  const oldReminder = `${SYSTEM_REMINDER_OPEN_TAG}
${TRUSTED_SYSTEM_REMINDER_SENTINEL}
当前模型：deepseek-v4-flash。
${SYSTEM_REMINDER_CLOSE_TAG}`;
  const currentReminder = `${SYSTEM_REMINDER_OPEN_TAG}
${TRUSTED_SYSTEM_REMINDER_SENTINEL}
当前模型：deepseek-v4-pro。
${SYSTEM_REMINDER_CLOSE_TAG}`;

  const context = engine.build({
    messages: [
      {
        id: "msg_old",
        content: `${oldReminder}\n\n旧问题`,
        createdAt: new Date(0).toISOString(),
        role: "user",
      },
      {
        id: "msg_current",
        content: `${currentReminder}\n\n你现在是什么模型`,
        createdAt: new Date(1).toISOString(),
        role: "user",
      },
    ],
    promptSnapshot: makePrompt("static system prompt"),
    runtimeReminderMessageId: "msg_current",
  });

  assert.equal(context.messages[1].content, "旧问题");
  assert.match(context.messages[2].content ?? "", /deepseek-v4-pro/);
  assert.doesNotMatch(JSON.stringify(context.messages), /deepseek-v4-flash/);
});
