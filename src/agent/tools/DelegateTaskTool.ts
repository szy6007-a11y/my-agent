import type { AgentTool, ToolExecutionContext, ToolValidationResult } from "@/agent/tools/types";
import { toolError, toolSuccess } from "@/agent/tools/types";

type DelegateTaskArgs = {
  background?: unknown;
  context?: unknown;
  description?: unknown;
  goal?: unknown;
  model?: unknown;
  role?: unknown;
  subject?: unknown;
  tasks?: unknown;
  toolsets?: unknown;
};

type NormalizedDelegateTask = {
  background: boolean;
  context: string;
  goal: string;
  model?: string | null;
  role: string;
  subject: string;
  toolsets: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {};
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function boolArg(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return value === true || value === "true";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean),
    ),
  ];
}

function normalizeDelegateTask(args: unknown): NormalizedDelegateTask {
  const input = asRecord(args) as DelegateTaskArgs;
  const rawTasks = Array.isArray(input.tasks) ? input.tasks.map(asRecord) : [];
  const task = rawTasks[0] ?? {};
  const goal =
    stringArg(task.goal) ||
    stringArg(task.prompt) ||
    stringArg(task.description) ||
    stringArg(input.goal) ||
    stringArg(input.description);
  const context = [stringArg(input.context), stringArg(task.context)].filter(Boolean).join("\n\n");
  const subject =
    stringArg(input.subject) ||
    stringArg(task.subject) ||
    stringArg(task.title) ||
    stringArg(task.description) ||
    goal.slice(0, 80);
  const toolsets = stringArray(input.toolsets).length > 0 ? stringArray(input.toolsets) : stringArray(task.toolsets);

  return {
    background: boolArg(input.background, true),
    context,
    goal,
    model: stringArg(input.model) || null,
    role: stringArg(input.role) || stringArg(task.role) || "leaf",
    subject,
    toolsets,
  };
}

function validateDelegateTask(args: unknown): ToolValidationResult {
  const input = asRecord(args) as DelegateTaskArgs;
  const rawTasks = Array.isArray(input.tasks) ? input.tasks : [];
  if (rawTasks.length > 1 && boolArg(input.background, true)) {
    return {
      ok: false,
      message: "background delegate_task supports exactly one task. Dispatch tasks one at a time.",
    };
  }

  const normalized = normalizeDelegateTask(args);
  if (!normalized.goal) {
    return { ok: false, message: "goal is required." };
  }

  return { ok: true };
}

export const delegateTaskTool: AgentTool = {
  definition: {
    function: {
      description:
        "Launch an isolated background subagent for independent research, codebase exploration, review, or verification. The only valid delegation tool name is delegate_task; do not call async, Task, Agent, subagent, or background as tool names. Use delegate_task when a subtask can run in parallel and only its final summary should return to the parent context. The child gets a separate session/run, restricted read-only tools, no user-question tool, no memory writes, and no recursive delegation. Default background=true returns immediately with a task handle; completion is delivered later as a normal session message and task/subagent events. Do not fabricate the child result or poll repeatedly; wait for the completion message or use task_output/task_list if the user asks for status. Do not use this for quick questions, tightly coupled step-by-step reasoning, or tasks that require writing files, approvals, or user clarification.",
      name: "delegate_task",
      parameters: {
        additionalProperties: false,
        properties: {
          background: {
            default: true,
            description:
              "Run asynchronously and return a handle immediately. Defaults to true.",
            type: "boolean",
          },
          context: {
            description:
              "Self-contained parent context, constraints, paths, evidence, and success criteria for the child.",
            type: "string",
          },
          description: {
            description: "Alias for goal when goal is omitted.",
            type: "string",
          },
          goal: {
            description:
              "The exact outcome the child subagent must produce. Must be self-contained.",
            type: "string",
          },
          model: {
            description: "Optional model override. Defaults to the parent/default model.",
            type: "string",
          },
          role: {
            default: "leaf",
            description: "Child role. Use leaf for normal subagents.",
            type: "string",
          },
          subject: {
            description: "Short display title for the delegated task.",
            type: "string",
          },
          tasks: {
            description:
              "Hermes-compatible single-task array. For background execution, pass at most one item.",
            items: {
              additionalProperties: true,
              type: "object",
            },
            maxItems: 1,
            type: "array",
          },
          toolsets: {
            description:
              "Requested read-only tool groups, for example ['web','file','session','skills']. Defaults to all safe read groups.",
            items: { type: "string" },
            type: "array",
          },
        },
        required: [],
        type: "object",
      },
    },
    type: "function",
  },
  isReadOnly: true,
  maxResultSizeChars: 12_000,
  name: "delegate_task",
  risk: "read",
  validateInput: validateDelegateTask,
  async execute(args, context: ToolExecutionContext) {
    const input = normalizeDelegateTask(args);
    try {
      const { dispatchDelegateTask } = await import("@/agent/tasks/AgentTaskRunner");
      const task = await dispatchDelegateTask({
        background: input.background,
        context: input.context,
        emitEvent: context.emitEvent,
        goal: input.goal,
        model: input.model || context.model,
        parentRunId: context.runId,
        parentSessionId: context.sessionId,
        permissionMode: context.permissionMode,
        role: input.role,
        subject: input.subject,
        toolsets: input.toolsets,
        userId: context.userId,
      });

      return toolSuccess({
        background: task.background,
        child_run_id: task.childRunId,
        child_session_id: task.childSessionId,
        completion:
          task.background ?
            "The delegated subagent is running in the background. Its final result will be appended to this session when complete."
          : "The delegated subagent finished before this tool returned.",
        status: task.status,
        task_id: task.id,
        task_subject: task.subject,
      });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "delegate_task failed.");
    }
  },
};
