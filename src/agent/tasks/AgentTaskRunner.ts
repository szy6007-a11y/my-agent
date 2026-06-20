import { AgentLoop } from "@/agent/runtime/AgentLoop";
import type {
  AgentEvent,
  AgentTaskSummary,
  PermissionMode,
  RunQueueMode,
} from "@/agent/runtime/types";
import {
  sessionRepository,
  type SessionRepository,
  type StoredAgentTask,
} from "@/agent/sessions/SessionRepository";
import { ToolRegistry, createSubagentTools } from "@/agent/tools/ToolRegistry";
import { deepseekModels } from "@/lib/ai/deepseek";

type DelegateTaskInput = {
  background?: boolean;
  context?: string;
  emitEvent?: (event: AgentEvent) => Promise<void> | void;
  goal: string;
  model?: string | null;
  parentRunId: string;
  parentSessionId: string;
  permissionMode?: PermissionMode;
  role?: string;
  subject?: string;
  toolsets?: string[];
  userId: string;
};

type BackgroundRunInput = {
  model: string;
  permissionMode: PermissionMode;
  sessions: SessionRepository;
  task: StoredAgentTask;
};

const activeDelegations = new Map<string, AbortController>();
const DEFAULT_SUBAGENT_TOOLSETS = ["web", "file", "session", "skills"];

function compactTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 48) || "后台子代理";
}

function resultPreview(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 500);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Subagent failed.";
}

function publicTask(task: StoredAgentTask): AgentTaskSummary {
  return {
    activeForm: task.activeForm,
    background: task.background,
    childRunId: task.childRunId,
    childSessionId: task.childSessionId,
    completedAt: task.completedAt,
    context: task.context,
    createdAt: task.createdAt,
    description: task.description,
    error: task.error,
    goal: task.goal,
    id: task.id,
    kind: task.kind,
    model: task.model,
    parentRunId: task.parentRunId,
    parentSessionId: task.parentSessionId,
    resultPreview: task.resultPreview,
    role: task.role,
    startedAt: task.startedAt,
    status: task.status,
    subject: task.subject,
    toolsets: task.toolsets,
    updatedAt: task.updatedAt,
  };
}

function buildChildPrompt(task: StoredAgentTask): string {
  const requestedToolsets = task.toolsets ?? [];
  const toolsets =
    requestedToolsets.length > 0 ?
      requestedToolsets.join(", ")
    : DEFAULT_SUBAGENT_TOOLSETS.join(", ");

  return [
    "你是由 delegate_task 启动的后台子代理。你只负责下面这一个任务。",
    "",
    "工作约束：",
    "- 独立完成任务，不要向用户提问，不要再次委派，不要调用记忆写入或用户确认类工具。",
    "- 只使用当前可见的只读工具和证据；如果证据不足，明确说明限制。",
    "- 你的中间推理和工具结果不会自动进入父代理上下文，最终回答必须自包含。",
    "- 最终回答使用用户当前对话的主要语言，并给出结论、关键证据、风险/未决项和建议的下一步。",
    "",
    `任务 ID：${task.id}`,
    `角色：${task.role || "leaf"}`,
    `允许工具集：${toolsets}`,
    "",
    "目标：",
    task.goal || task.subject,
    "",
    "上下文：",
    task.context || "(无额外上下文)",
  ].join("\n");
}

function formatCompletionMessage(task: StoredAgentTask, finalResponse: string): string {
  return [
    `后台子代理已完成：${task.subject}`,
    "",
    finalResponse.trim() || "子代理没有返回可用内容。",
    "",
    `任务 ID：${task.id}`,
  ].join("\n");
}

function formatFailureMessage(task: StoredAgentTask, error: string): string {
  return [`后台子代理失败：${task.subject}`, "", error, "", `任务 ID：${task.id}`].join("\n");
}

async function appendParentEvent(
  sessions: SessionRepository,
  parentRunId: string | null | undefined,
  event: AgentEvent,
) {
  if (!parentRunId) {
    return;
  }
  await sessions.appendRunEvent(parentRunId, event);
}

async function appendCompletionToParentSession(input: {
  content: string;
  parentSessionId: string;
  sessions: SessionRepository;
  userId: string;
}) {
  const head =
    (await input.sessions.resolveCompressionHead({
      sessionId: input.parentSessionId,
      userId: input.userId,
    })) ?? { id: input.parentSessionId };

  await input.sessions.appendMessage({
    content: input.content,
    role: "assistant",
    sessionId: head.id,
  });
  await input.sessions.touchSession(head.id, input.userId);
}

async function runBackgroundSubagent(input: BackgroundRunInput) {
  const { sessions } = input;
  const controller = new AbortController();
  activeDelegations.set(input.task.id, controller);

  let task = input.task;
  try {
    task =
      (await sessions.updateAgentTask({
        activeForm: "后台子代理运行中",
        status: "running",
        taskId: task.id,
        userId: task.userId,
      })) ?? task;
    await appendParentEvent(sessions, task.parentRunId, {
      type: "task.updated",
      runId: task.parentRunId ?? input.task.parentRunId ?? "",
      task: publicTask(task),
    });
    await appendParentEvent(sessions, task.parentRunId, {
      type: "subagent.started",
      activity: "后台子代理已启动",
      runId: task.parentRunId ?? input.task.parentRunId ?? "",
      task: publicTask(task),
    });

    const childSession = await sessions.createSession({
      parentSessionId: task.parentSessionId,
      title: compactTitle(task.subject),
      userId: task.userId,
    });
    const childRun = await sessions.createRun({
      model: input.model,
      permissionMode: input.permissionMode,
      sessionId: childSession.id,
      userId: task.userId,
    });
    task =
      (await sessions.updateAgentTask({
        childRunId: childRun.id,
        childSessionId: childSession.id,
        taskId: task.id,
        userId: task.userId,
      })) ?? task;

    const queueMode: RunQueueMode = "followup";
    await sessions.appendRunEvent(childRun.id, {
      type: "run.accepted",
      queueMode,
      runId: childRun.id,
      sessionId: childSession.id,
    });

    const claimed = await sessions.waitForRunTurn({
      runId: childRun.id,
      signal: controller.signal,
      userId: task.userId,
    });
    if (claimed.status !== "preparing") {
      throw new Error(`Child run ended before execution: ${claimed.status}`);
    }

    const childUserMessage = await sessions.appendMessage({
      content: buildChildPrompt(task),
      role: "user",
      sessionId: childSession.id,
    });

    const loop = new AgentLoop(
      undefined,
      undefined,
      sessions,
      undefined,
      undefined,
      undefined,
      () => new ToolRegistry(createSubagentTools(task.toolsets ?? [])),
      { backgroundReview: false, maxToolRounds: 40 },
    );

    let finalMessageId: string | null = null;
    let activeChildSessionId = childSession.id;
    for await (const event of loop.execute({
      maxTokens: 2048,
      model: input.model,
      permissionMode: input.permissionMode,
      runId: childRun.id,
      sessionId: childSession.id,
      signal: controller.signal,
      thinking: "disabled",
      userId: task.userId,
      userMessageId: childUserMessage.id,
    })) {
      await sessions.appendRunEvent(childRun.id, event);

      if (event.type === "context.compacted" && event.sessionId) {
        activeChildSessionId = event.sessionId;
        task =
          (await sessions.updateAgentTask({
            childSessionId: activeChildSessionId,
            taskId: task.id,
            userId: task.userId,
          })) ?? task;
      }

      if (event.type === "tool.started") {
        await appendParentEvent(sessions, task.parentRunId, {
          type: "subagent.progress",
          activity: `调用 ${event.toolName}`,
          runId: task.parentRunId ?? "",
          task: publicTask(task),
        });
      }

      if (event.type === "run.completed") {
        finalMessageId = event.finalMessageId;
      }

      if (event.type === "run.failed") {
        throw new Error(event.error);
      }

      if (event.type === "run.aborted") {
        throw new Error(event.reason || "Child run aborted.");
      }
    }

    const messages = await sessions.listMessages(activeChildSessionId, {
      limit: 20,
      userId: task.userId,
    });
    const finalMessage =
      messages.find((message) => message.id === finalMessageId) ??
      [...messages].reverse().find((message) => message.role === "assistant");
    const finalResponse = finalMessage?.content.trim() || "子代理没有返回可用内容。";

    task =
      (await sessions.updateAgentTask({
        activeForm: "已完成",
        childSessionId: activeChildSessionId,
        result: {
          childFinalMessageId: finalMessageId,
          finalResponse,
          summary: resultPreview(finalResponse),
        },
        status: "completed",
        taskId: task.id,
        userId: task.userId,
      })) ?? task;

    await appendCompletionToParentSession({
      content: formatCompletionMessage(task, finalResponse),
      parentSessionId: task.parentSessionId ?? input.task.parentSessionId ?? "",
      sessions,
      userId: task.userId,
    });
    await appendParentEvent(sessions, task.parentRunId, {
      type: "task.completed",
      resultPreview: task.resultPreview ?? undefined,
      runId: task.parentRunId ?? "",
      task: publicTask(task),
    });
    await appendParentEvent(sessions, task.parentRunId, {
      type: "subagent.completed",
      resultPreview: task.resultPreview ?? undefined,
      runId: task.parentRunId ?? "",
      task: publicTask(task),
    });
  } catch (error) {
    const message = errorMessage(error);
    if (controller.signal.aborted && task.childRunId) {
      await sessions.abortRunForUser({
        reason: "delegated_task_cancelled",
        runId: task.childRunId,
        userId: task.userId,
      });
    }
    task =
      (await sessions.updateAgentTask({
        activeForm: controller.signal.aborted ? "已取消" : "失败",
        error: { message },
        status: controller.signal.aborted ? "cancelled" : "failed",
        taskId: task.id,
        userId: task.userId,
      })) ?? task;

    await appendCompletionToParentSession({
      content: formatFailureMessage(task, message),
      parentSessionId: task.parentSessionId ?? input.task.parentSessionId ?? "",
      sessions,
      userId: task.userId,
    });
    await appendParentEvent(sessions, task.parentRunId, {
      type: controller.signal.aborted ? "task.cancelled" : "task.failed",
      ...(controller.signal.aborted ? { reason: message } : { error: message }),
      runId: task.parentRunId ?? "",
      task: publicTask(task),
    } as AgentEvent);
    await appendParentEvent(sessions, task.parentRunId, {
      type: "subagent.failed",
      error: message,
      runId: task.parentRunId ?? "",
      task: publicTask(task),
    });
  } finally {
    activeDelegations.delete(input.task.id);
  }
}

export async function dispatchDelegateTask(
  input: DelegateTaskInput,
  sessions: SessionRepository = sessionRepository,
): Promise<StoredAgentTask> {
  const model = input.model?.trim() || input.model || deepseekModels.default;
  const background = input.background ?? true;
  const toolsets = input.toolsets && input.toolsets.length > 0 ? input.toolsets : DEFAULT_SUBAGENT_TOOLSETS;
  const task = await sessions.createAgentTask({
    activeForm: background ? "等待后台子代理启动" : "等待子代理执行",
    background,
    context: input.context ?? "",
    description: input.context ?? "",
    goal: input.goal,
    kind: "subagent",
    metadata: {
      delegateTask: true,
      parentPermissionMode: input.permissionMode ?? null,
    },
    model,
    parentRunId: input.parentRunId,
    parentSessionId: input.parentSessionId,
    role: input.role ?? "leaf",
    status: "queued",
    subject: input.subject || compactTitle(input.goal),
    toolsets,
    userId: input.userId,
  });

  await input.emitEvent?.({
    type: "task.created",
    runId: input.parentRunId,
    task: publicTask(task),
  });
  await input.emitEvent?.({
    type: "subagent.started",
    activity: background ? "后台子代理已排队" : "子代理已排队",
    runId: input.parentRunId,
    task: publicTask(task),
  });

  const runInput: BackgroundRunInput = {
    model,
    permissionMode: "read-only",
    sessions,
    task,
  };

  if (background) {
    void runBackgroundSubagent(runInput).catch((error) => {
      console.error("Background delegate_task failed", error);
    });
    return task;
  }

  await runBackgroundSubagent(runInput);
  return (
    (await sessions.getAgentTaskForUser({
      taskId: task.id,
      userId: task.userId,
    })) ?? task
  );
}

export async function cancelDelegatedTask(input: {
  reason?: string;
  taskId: string;
  userId: string;
  sessions?: SessionRepository;
}): Promise<StoredAgentTask | null> {
  const sessions = input.sessions ?? sessionRepository;
  const controller = activeDelegations.get(input.taskId);
  controller?.abort(input.reason ?? "cancelled");

  const task = await sessions.cancelAgentTask({
    reason: input.reason,
    taskId: input.taskId,
    userId: input.userId,
  });

  if (task?.childRunId) {
    await sessions.abortRunForUser({
      reason: input.reason ?? "delegated_task_cancelled",
      runId: task.childRunId,
      userId: input.userId,
    });
  }

  return task;
}
