import type { AgentTaskStatus, AgentTaskSummary } from "@/agent/runtime/types";
import type { AgentTool, ToolExecutionContext, ToolValidationResult } from "@/agent/tools/types";
import { toolError, toolSuccess } from "@/agent/tools/types";

type TaskCreateArgs = {
  active_form?: unknown;
  description?: unknown;
  status?: unknown;
  subject?: unknown;
  title?: unknown;
};

type TaskUpdateArgs = {
  active_form?: unknown;
  description?: unknown;
  error?: unknown;
  result?: unknown;
  status?: unknown;
  subject?: unknown;
  task_id?: unknown;
  title?: unknown;
};

type TaskOutputArgs = {
  task_id?: unknown;
};

type TaskListArgs = {
  limit?: unknown;
};

const TASK_STATUSES: AgentTaskStatus[] = [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {};
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalStatus(value: unknown): AgentTaskStatus | undefined {
  return TASK_STATUSES.includes(value as AgentTaskStatus) ? (value as AgentTaskStatus) : undefined;
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 25;
  }
  return Math.max(1, Math.min(100, Math.trunc(parsed)));
}

function taskPayload(task: AgentTaskSummary): Record<string, unknown> {
  return {
    active_form: task.activeForm,
    background: task.background,
    child_run_id: task.childRunId,
    child_session_id: task.childSessionId,
    completed_at: task.completedAt,
    created_at: task.createdAt,
    description: task.description,
    error: task.error,
    id: task.id,
    kind: task.kind,
    parent_run_id: task.parentRunId,
    result_preview: task.resultPreview,
    status: task.status,
    subject: task.subject,
    updated_at: task.updatedAt,
  };
}

async function emitTaskStatus(context: ToolExecutionContext, task: AgentTaskSummary) {
  if (!context.emitEvent) {
    return;
  }

  if (task.status === "completed") {
    await context.emitEvent({
      type: "task.completed",
      resultPreview: task.resultPreview ?? undefined,
      runId: context.runId,
      task,
    });
    return;
  }

  if (task.status === "failed") {
    await context.emitEvent({
      type: "task.failed",
      error: task.error ?? "Task failed.",
      runId: context.runId,
      task,
    });
    return;
  }

  if (task.status === "cancelled") {
    await context.emitEvent({
      type: "task.cancelled",
      reason: task.error ?? undefined,
      runId: context.runId,
      task,
    });
    return;
  }

  await context.emitEvent({
    type: "task.updated",
    runId: context.runId,
    task,
  });
}

function requireTaskId(args: unknown): ToolValidationResult {
  const input = asRecord(args) as TaskOutputArgs;
  if (!stringArg(input.task_id)) {
    return { ok: false, message: "task_id is required." };
  }
  return { ok: true };
}

export function createTaskTools(): AgentTool[] {
  const taskCreateTool: AgentTool = {
    definition: {
      function: {
        description:
          "Create or record a local task item for multi-step work. Use this immediately when the user asks for several deliverables, when you need a checklist to track progress, or before launching background delegation. Keep subjects short and update the task as work progresses.",
        name: "task_create",
        parameters: {
          additionalProperties: false,
          properties: {
            active_form: {
              description: "Present-tense progress label, for example 'Reading docs'.",
              type: "string",
            },
            description: {
              description: "Optional details, acceptance notes, or dependencies.",
              type: "string",
            },
            status: {
              description: "Initial task status. Defaults to pending.",
              enum: TASK_STATUSES,
              type: "string",
            },
            subject: {
              description: "Short task title.",
              type: "string",
            },
            title: {
              description: "Alias for subject.",
              type: "string",
            },
          },
          required: [],
          type: "object",
        },
      },
      type: "function",
    },
    isReadOnly: true,
    name: "task_create",
    risk: "read",
    validateInput(args) {
      const input = asRecord(args) as TaskCreateArgs;
      const subject = stringArg(input.subject) || stringArg(input.title);
      if (!subject) {
        return { ok: false, message: "subject is required." };
      }
      return { ok: true };
    },
    async execute(args, context) {
      const input = asRecord(args) as TaskCreateArgs;
      const subject = stringArg(input.subject) || stringArg(input.title);
      const task = await context.sessions.createAgentTask({
        activeForm: stringArg(input.active_form) || null,
        description: stringArg(input.description),
        parentRunId: context.runId,
        parentSessionId: context.sessionId,
        status: optionalStatus(input.status) ?? "pending",
        subject,
        userId: context.userId,
      });

      await context.emitEvent?.({
        type: "task.created",
        runId: context.runId,
        task,
      });

      if (task.status !== "pending") {
        await emitTaskStatus(context, task);
      }

      return toolSuccess({ task: taskPayload(task) });
    },
  };

  const taskListTool: AgentTool = {
    definition: {
      function: {
        description:
          "List local task and subagent records for the current session. Use this to recover task state before updating or reporting progress.",
        name: "task_list",
        parameters: {
          additionalProperties: false,
          properties: {
            limit: {
              description: "Maximum tasks to return. Default 25, maximum 100.",
              type: "integer",
            },
          },
          required: [],
          type: "object",
        },
      },
      type: "function",
    },
    isReadOnly: true,
    name: "task_list",
    risk: "read",
    async execute(args, context) {
      const input = asRecord(args) as TaskListArgs;
      const tasks = await context.sessions.listAgentTasks({
        includeAncestors: true,
        limit: clampLimit(input.limit),
        sessionId: context.sessionId,
        userId: context.userId,
      });
      return toolSuccess({ tasks: tasks.map(taskPayload) });
    },
  };

  const taskUpdateTool: AgentTool = {
    definition: {
      function: {
        description:
          "Update a local task's title, description, active progress text, status, result, or error. Call this whenever a tracked task starts, progresses, completes, fails, or is interrupted.",
        name: "task_update",
        parameters: {
          additionalProperties: false,
          properties: {
            active_form: {
              description: "Present-tense progress label, for example 'Writing tests'.",
              type: "string",
            },
            description: { type: "string" },
            error: {
              description: "Failure or cancellation detail. Object or string.",
            },
            result: {
              description: "Completion result, summary, or structured payload.",
            },
            status: {
              enum: TASK_STATUSES,
              type: "string",
            },
            subject: { type: "string" },
            task_id: { type: "string" },
            title: {
              description: "Alias for subject.",
              type: "string",
            },
          },
          required: ["task_id"],
          type: "object",
        },
      },
      type: "function",
    },
    isReadOnly: true,
    name: "task_update",
    risk: "read",
    validateInput: requireTaskId,
    async execute(args, context) {
      const input = asRecord(args) as TaskUpdateArgs;
      const taskId = stringArg(input.task_id);
      const status = optionalStatus(input.status);
      const hasResult = Object.prototype.hasOwnProperty.call(input, "result");
      const hasError = Object.prototype.hasOwnProperty.call(input, "error");
      const task = await context.sessions.updateAgentTask({
        ...(stringArg(input.active_form) ? { activeForm: stringArg(input.active_form) } : {}),
        ...(stringArg(input.description) ? { description: stringArg(input.description) } : {}),
        ...(hasError ? { error: input.error } : {}),
        ...(hasResult ? { result: input.result } : {}),
        ...(status ? { status } : {}),
        ...(stringArg(input.subject) || stringArg(input.title) ?
          { subject: stringArg(input.subject) || stringArg(input.title) }
        : {}),
        taskId,
        userId: context.userId,
      });

      if (!task) {
        return toolError("Task not found or not writable by user.");
      }

      await emitTaskStatus(context, task);
      return toolSuccess({ task: taskPayload(task) });
    },
  };

  const taskOutputTool: AgentTool = {
    definition: {
      function: {
        description:
          "Read one local task or subagent record, including full metadata, result, and error details.",
        name: "task_output",
        parameters: {
          additionalProperties: false,
          properties: {
            task_id: { type: "string" },
          },
          required: ["task_id"],
          type: "object",
        },
      },
      type: "function",
    },
    isReadOnly: true,
    name: "task_output",
    risk: "read",
    validateInput: requireTaskId,
    async execute(args, context) {
      const input = asRecord(args) as TaskOutputArgs;
      const task = await context.sessions.getAgentTaskForUser({
        taskId: stringArg(input.task_id),
        userId: context.userId,
      });
      if (!task) {
        return toolError("Task not found or not readable by user.");
      }
      return toolSuccess({
        task: {
          ...taskPayload(task),
          context: task.context,
          goal: task.goal,
          metadata: task.metadata,
          result: task.result,
          toolsets: task.toolsets,
        },
      });
    },
  };

  const taskCancelTool: AgentTool = {
    definition: {
      function: {
        description:
          "Cancel a local task or background subagent. Use this when the user changes direction or asks to stop a delegated task.",
        name: "task_cancel",
        parameters: {
          additionalProperties: false,
          properties: {
            reason: { type: "string" },
            task_id: { type: "string" },
          },
          required: ["task_id"],
          type: "object",
        },
      },
      type: "function",
    },
    isReadOnly: true,
    name: "task_cancel",
    risk: "read",
    validateInput: requireTaskId,
    async execute(args, context) {
      const input = asRecord(args) as TaskOutputArgs & { reason?: unknown };
      const { cancelDelegatedTask } = await import("@/agent/tasks/AgentTaskRunner");
      const task = await cancelDelegatedTask({
        sessions: context.sessions,
        reason: stringArg(input.reason),
        taskId: stringArg(input.task_id),
        userId: context.userId,
      });
      if (!task) {
        return toolError("Task not found or not writable by user.");
      }
      await context.emitEvent?.({
        type: "task.cancelled",
        reason: task.error ?? stringArg(input.reason) ?? undefined,
        runId: context.runId,
        task,
      });
      return toolSuccess({ task: taskPayload(task) });
    },
  };

  return [taskCreateTool, taskListTool, taskUpdateTool, taskOutputTool, taskCancelTool];
}
