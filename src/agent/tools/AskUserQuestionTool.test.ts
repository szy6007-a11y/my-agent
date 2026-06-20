import assert from "node:assert/strict";
import test from "node:test";

import type { ModelToolCall } from "@/agent/runtime/types";
import type { StoredToolApproval } from "@/agent/sessions/SessionRepository";
import { askUserQuestionTool } from "@/agent/tools/AskUserQuestionTool";
import type { ToolExecutionContext } from "@/agent/tools/types";

const questionInput = {
  questions: [
    {
      question: "接下来优先处理哪一类工作？",
      header: "下一步",
      options: [
        {
          label: "先补测试 (Recommended)",
          description: "先锁住行为，再继续实现。",
          preview: "npm test -- ask-user-question",
        },
        {
          label: "先写 UI",
          description: "先把交互体验接起来。",
        },
      ],
    },
  ],
};

const toolCall: ModelToolCall = {
  arguments: JSON.stringify(questionInput),
  id: "call_question",
  name: "ask_user_question",
};

const context = {
  runId: "run_1",
  sessionId: "sess_1",
  sessions: {} as never,
  userId: "usr_1",
} satisfies ToolExecutionContext;

function approval(overrides: Partial<StoredToolApproval> = {}): StoredToolApproval {
  return {
    id: "approval_1",
    createdAt: new Date(0).toISOString(),
    decision: null,
    reason: "Agent 需要你回答一个问题后继续。",
    request: {},
    resolvedAt: null,
    risk: "read",
    runId: "run_1",
    sessionId: "sess_1",
    status: "approved",
    toolCallId: "call_question",
    toolName: "ask_user_question",
    userId: "usr_1",
    ...overrides,
  };
}

test("ask_user_question builds a structured interaction approval request", async () => {
  const validation = await askUserQuestionTool.validateInput?.(
    questionInput,
    context,
    toolCall,
  );
  const request = await askUserQuestionTool.buildApproval?.(
    questionInput,
    context,
    toolCall,
  );

  assert.deepEqual(validation, { ok: true });
  assert.equal(request?.reason, "Agent 需要你回答一个问题后继续。");
  assert.deepEqual(request?.request, {
    kind: "ask_user_question",
    questions: questionInput.questions,
  });
});

test("ask_user_question description teaches when to call the tool", () => {
  const description = askUserQuestionTool.definition.function.description;

  assert.match(description, /Gather user preferences/);
  assert.match(description, /Clarify ambiguous instructions/);
  assert.match(description, /implementation choices/);
  assert.match(description, /Do not add an Other option yourself/);
});

test("ask_user_question applies approval answers before execution", async () => {
  const approvedArgs = await askUserQuestionTool.applyApprovalDecision?.(
    questionInput,
    approval({
      decision: {
        decision: "approved",
        response: {
          answers: {
            "接下来优先处理哪一类工作？": "先补测试 (Recommended)",
          },
          annotations: {
            "接下来优先处理哪一类工作？": {
              notes: "用户希望先稳住行为。",
              preview: "npm test -- ask-user-question",
            },
          },
        },
      },
    }),
    context,
    toolCall,
  );
  const result = JSON.parse(
    await askUserQuestionTool.execute(approvedArgs, context, toolCall),
  ) as Record<string, unknown>;

  assert.equal(result.success, true);
  assert.deepEqual(result.answers, {
    "接下来优先处理哪一类工作？": "先补测试 (Recommended)",
  });
  assert.deepEqual(result.annotations, {
    "接下来优先处理哪一类工作？": {
      notes: "用户希望先稳住行为。",
      preview: "npm test -- ask-user-question",
    },
  });
});

test("ask_user_question rejects approved executions without answers", async () => {
  assert.throws(
    () =>
      askUserQuestionTool.applyApprovalDecision?.(
        questionInput,
        approval({ decision: { decision: "approved" } }),
        context,
        toolCall,
      ),
    /User answers were not provided/,
  );
});
