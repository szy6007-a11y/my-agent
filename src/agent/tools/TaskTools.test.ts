import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "@/agent/runtime/types";
import type { StoredAgentTask } from "@/agent/sessions/SessionRepository";
import { createTaskTools } from "@/agent/tools/TaskTools";
import type { ToolExecutionContext } from "@/agent/tools/types";

function baseTask(overrides: Partial<StoredAgentTask> = {}): StoredAgentTask {
  const now = "2026-06-20T00:00:00.000Z";
  return {
    background: false,
    createdAt: now,
    description: "",
    errorDetail: null,
    id: "task_test",
    kind: "task",
    metadata: {},
    result: null,
    status: "pending",
    subject: "梳理登录流程",
    updatedAt: now,
    userId: "usr_test",
    ...overrides,
  };
}

function toolContext(
  sessions: Partial<ToolExecutionContext["sessions"]>,
  events: AgentEvent[],
): ToolExecutionContext {
  return {
    emitEvent: (event) => {
      events.push(event);
    },
    runId: "run_test",
    sessionId: "sess_test",
    sessions: sessions as ToolExecutionContext["sessions"],
    userId: "usr_test",
  };
}

test("task_create persists a task and emits task.created", async () => {
  const events: AgentEvent[] = [];
  const tool = createTaskTools().find((item) => item.name === "task_create");
  assert.ok(tool);

  const result = await tool.execute(
    { active_form: "检查中", subject: "梳理登录流程" },
    toolContext(
      {
        createAgentTask: async (input) => {
          assert.equal(input.parentRunId, "run_test");
          assert.equal(input.parentSessionId, "sess_test");
          assert.equal(input.subject, "梳理登录流程");
          return baseTask({
            activeForm: input.activeForm,
            status: input.status,
            subject: input.subject,
          });
        },
      },
      events,
    ),
    { arguments: "{}", id: "call_test", name: "task_create" },
  );

  const parsed = JSON.parse(result) as { success: boolean; task: { id: string } };
  assert.equal(parsed.success, true);
  assert.equal(parsed.task.id, "task_test");
  assert.equal(events[0]?.type, "task.created");
});

test("task_update emits task.completed with result preview", async () => {
  const events: AgentEvent[] = [];
  const tool = createTaskTools().find((item) => item.name === "task_update");
  assert.ok(tool);

  await tool.execute(
    { result: { summary: "登录流程已梳理完" }, status: "completed", task_id: "task_test" },
    toolContext(
      {
        updateAgentTask: async (input) => {
          assert.equal(input.taskId, "task_test");
          assert.equal(input.status, "completed");
          return baseTask({
            completedAt: "2026-06-20T00:01:00.000Z",
            resultPreview: "登录流程已梳理完",
            status: "completed",
          });
        },
      },
      events,
    ),
    { arguments: "{}", id: "call_test", name: "task_update" },
  );

  assert.equal(events[0]?.type, "task.completed");
  assert.equal(
    events[0]?.type === "task.completed" ? events[0].resultPreview : "",
    "登录流程已梳理完",
  );
});
