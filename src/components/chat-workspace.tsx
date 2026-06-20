"use client";

import {
  Activity,
  Check,
  ChevronDown,
  CircleStop,
  Copy,
  Download,
  FileText,
  LogOut,
  Library,
  Mic,
  MoreHorizontal,
  Paperclip,
  PanelsLeftBottom,
  Plus,
  Search,
  Send,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { code as streamdownCode } from "@streamdown/code";
import { Streamdown } from "streamdown";

import type {
  ServiceHealthSnapshot,
  ServiceHealthState,
  ServiceHealthStatus,
} from "@/lib/service-health";
import type {
  AgentArtifact,
  AgentTaskSummary,
  AgentEvent,
  AskUserQuestion,
  AskUserQuestionRequest,
  AskUserQuestionResponse,
} from "@/shared/agent-protocol";
import { stripTrustedRuntimeReminder } from "@/shared/runtime-reminder";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  artifacts?: AgentArtifact[];
  createdAt?: string;
  reasoningContent?: string;
  status?: "streaming" | "complete" | "failed" | "aborted";
};

type ChatMessagePayload = {
  artifacts?: AgentArtifact[];
  content: string;
  createdAt?: string;
  id: string;
  role: "user" | "assistant";
};

type AuthUser = {
  id: string;
  environment: "dev" | "sit" | "prod";
  displayName: string | null;
};

type AuthStatus = "checking" | "anonymous" | "authenticated";

type ChatSession = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

type MonitorConnection = "connecting" | "connected" | "disconnected";

type ActiveRunStatus = "accepted" | "running" | "waiting_approval" | "cancelling";

type ActiveRunState = {
  queueMode?: Extract<AgentEvent, { type: "run.accepted" }>["queueMode"];
  runId: string;
  sessionId: string;
  status: ActiveRunStatus;
};

type PendingApproval = {
  approvalId: string;
  reason: string;
  request?: unknown;
  risk: Extract<AgentEvent, { type: "tool.approval.required" }>["risk"];
  runId: string;
  state: "pending" | "submitting";
  toolCallId: string;
  toolName: string;
};

type TaskCardState = AgentTaskSummary & {
  lastActivity?: string;
};

type ServiceConsoleLog = {
  id: string;
  at: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
};

type ServiceSnapshotEvent = {
  type: "status.snapshot";
  sequence: number;
  snapshot: ServiceHealthSnapshot;
};

type ServiceLogEvent = {
  type: "status.log";
  sequence: number;
  at: string;
  level: ServiceConsoleLog["level"];
  source: string;
  message: string;
};

const MAX_CONSOLE_LOGS = 28;
const COMPOSER_TEXTAREA_MAX_HEIGHT = 96;
const SCROLL_BOTTOM_FALLBACK_THRESHOLD = 96;
const SCROLL_BOTTOM_ROOT_MARGIN = "0px 0px -96px 0px";

function parseSseEvent(eventText: string): AgentEvent | null {
  const dataLines = eventText
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));

  if (dataLines.length === 0) {
    return null;
  }

  return JSON.parse(dataLines.join("\n")) as AgentEvent;
}

function parseServiceEvent<T>(event: Event) {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

function shortRunId(runId: string) {
  return runId.replace(/^run_/, "").slice(0, 8);
}

function shortSessionId(sessionId: string) {
  return sessionId.replace(/^sess_/, "").slice(0, 8);
}

function shortTaskId(taskId: string) {
  return taskId.replace(/^task_/, "").slice(0, 8);
}

function formatConsoleTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatSessionTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function displayUserName(user: AuthUser | null) {
  if (!user) return "内测用户";
  return user.displayName?.trim() || `用户 ${user.id.replace(/^usr_/, "").slice(0, 6)}`;
}

function environmentLabel(environment?: AuthUser["environment"]) {
  if (environment === "prod") return "PROD";
  if (environment === "sit") return "SIT";
  return "DEV";
}

function connectionLabel(connection: MonitorConnection) {
  if (connection === "connected") return "在线";
  if (connection === "disconnected") return "重连中";
  return "连接中";
}

function healthStatusLabel(status: ServiceHealthStatus) {
  return status === "ok" ? "服务正常" : "需要关注";
}

function serviceStateLabel(state: ServiceHealthState) {
  if (state === "ok") return "正常";
  if (state === "disabled") return "未启用";
  return "告警";
}

function runStatusLabel(status: ActiveRunStatus) {
  if (status === "accepted") return "排队中";
  if (status === "waiting_approval") return "等待确认";
  if (status === "cancelling") return "停止中";
  return "运行中";
}

function taskStatusLabel(status: AgentTaskSummary["status"]) {
  if (status === "pending") return "待处理";
  if (status === "queued") return "排队中";
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return "已中断";
}

function taskIsActive(task: Pick<AgentTaskSummary, "status">) {
  return task.status === "pending" || task.status === "queued" || task.status === "running";
}

function taskNeedsAttention(task: Pick<AgentTaskSummary, "status">) {
  return task.status === "failed" || task.status === "cancelled" || task.status === "interrupted";
}

function formatSyncedAt(value: string | null) {
  if (!value) {
    return "等待同步";
  }
  return `同步 ${formatConsoleTime(value)}`;
}

function formatTaskDuration(task: AgentTaskSummary) {
  if (!task.startedAt) {
    return null;
  }
  const started = new Date(task.startedAt).getTime();
  const ended = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    return null;
  }
  const seconds = Math.max(1, Math.round((ended - started) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function logLevelLabel(level: ServiceConsoleLog["level"]) {
  if (level === "error") return "错误";
  if (level === "warn") return "警告";
  return "信息";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : null;
}

function approvalDetails(request: unknown): unknown {
  const requestRecord = asRecord(request);
  return requestRecord && "details" in requestRecord ? requestRecord.details : request;
}

function askUserQuestionRequestFromApproval(
  request: unknown,
): AskUserQuestionRequest | null {
  const details = approvalDetails(request);
  const record = asRecord(details);
  if (record?.kind !== "ask_user_question" || !Array.isArray(record.questions)) {
    return null;
  }

  return record as AskUserQuestionRequest;
}

function approvalDetailLines(request: unknown): string[] {
  const details = approvalDetails(request);
  if (!details || typeof details !== "object") {
    return [];
  }
  const record = details as Record<string, unknown>;
  if (record.kind === "ask_user_question") {
    return [];
  }
  const operation =
    record.operation === "create" ? "创建"
    : record.operation === "update" ? "覆盖"
    : record.operation === "write" ? "写入"
    : record.operation;
  return [
    record.path ? `文件：${String(record.path)}` : "",
    operation ? `操作：${String(operation)}` : "",
    typeof record.sizeBytes === "number" ? `大小：${formatBytes(record.sizeBytes)}` : "",
    record.sourceUrl ? `来源：${String(record.sourceUrl)}` : "",
    record.commitSha ? `Commit：${String(record.commitSha).slice(0, 12)}` : "",
    record.proposalId ? `提案：${String(record.proposalId).replace(/^skill_/, "").slice(0, 8)}` : "",
    record.trustLevel ? `信任级别：${String(record.trustLevel)}` : "",
  ].filter(Boolean);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "未知大小";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function appendMessageContent(
  messages: ChatMessage[],
  messageId: string,
  text: string,
) {
  return messages.map((message) =>
    message.id === messageId ?
      { ...message, content: message.content + text }
    : message,
  );
}

function retractMessageContent(
  messages: ChatMessage[],
  messageId: string,
  text: string,
) {
  return messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    if (message.content.endsWith(text)) {
      return { ...message, content: message.content.slice(0, -text.length) };
    }

    return { ...message, content: message.content.replace(text, "") };
  });
}

function appendMessageReasoning(
  messages: ChatMessage[],
  messageId: string,
  text: string,
) {
  return messages.map((message) =>
    message.id === messageId ?
      { ...message, reasoningContent: `${message.reasoningContent ?? ""}${text}` }
    : message,
  );
}

function appendMessageArtifact(
  messages: ChatMessage[],
  messageId: string,
  artifact: AgentArtifact,
) {
  return messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }
    const artifacts = message.artifacts ?? [];
    if (artifacts.some((item) => item.id === artifact.id)) {
      return message;
    }
    return { ...message, artifacts: [...artifacts, artifact] };
  });
}

function updateMessage(
  messages: ChatMessage[],
  messageId: string,
  updates: Partial<ChatMessage>,
) {
  return messages.map((message) =>
    message.id === messageId ? { ...message, ...updates } : message,
  );
}

function toChatMessage(message: ChatMessagePayload): ChatMessage {
  return {
    artifacts: message.artifacts,
    content:
      message.role === "user" ?
        stripTrustedRuntimeReminder(message.content)
      : message.content,
    createdAt: message.createdAt,
    id: message.id,
    role: message.role,
    status: "complete",
  };
}

function toChatMessages(messages: ChatMessagePayload[]): ChatMessage[] {
  return messages.map(toChatMessage);
}

function messagesChanged(current: ChatMessage[], next: ChatMessage[]) {
  if (current.length !== next.length) {
    return true;
  }

  return current.some((message, index) => {
    const candidate = next[index];
    return (
      !candidate ||
      candidate.id !== message.id ||
      candidate.content !== message.content ||
      (candidate.artifacts?.length ?? 0) !== (message.artifacts?.length ?? 0)
    );
  });
}

function taskEventUpdate(event: AgentEvent): { activity?: string; task: AgentTaskSummary } | null {
  if (
    event.type === "task.created" ||
    event.type === "task.updated" ||
    event.type === "task.completed" ||
    event.type === "task.failed" ||
    event.type === "task.cancelled"
  ) {
    return { task: event.task };
  }

  if (
    event.type === "subagent.started" ||
    event.type === "subagent.progress" ||
    event.type === "subagent.completed" ||
    event.type === "subagent.failed"
  ) {
    const activity =
      event.type === "subagent.started" || event.type === "subagent.progress" ?
        event.activity
      : undefined;
    return { activity, task: event.task };
  }

  return null;
}

function taskSortRank(task: TaskCardState) {
  if (task.kind === "subagent" && taskIsActive(task)) return 0;
  if (task.status === "running") return 1;
  if (taskNeedsAttention(task)) return 2;
  if (task.status === "queued" || task.status === "pending") return 3;
  return 4;
}

function upsertTaskCard(
  tasks: TaskCardState[],
  update: { activity?: string; task: AgentTaskSummary },
) {
  const nextTask: TaskCardState = {
    ...update.task,
    ...(update.activity ? { lastActivity: update.activity } : {}),
  };
  const merged = tasks.some((task) => task.id === update.task.id) ?
    tasks.map((task) =>
      task.id === update.task.id ?
        {
          ...task,
          ...nextTask,
          lastActivity: update.activity ?? task.lastActivity,
        }
      : task,
    )
  : [nextTask, ...tasks];

  return sortTaskCards(merged);
}

function sortTaskCards(tasks: TaskCardState[]) {
  return [...tasks]
    .sort((left, right) => {
      const rank = taskSortRank(left) - taskSortRank(right);
      if (rank !== 0) {
        return rank;
      }
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    })
    .slice(0, 12);
}

function ArtifactList({ artifacts }: { artifacts?: AgentArtifact[] }) {
  if (!artifacts?.length) {
    return null;
  }

  return (
    <div className="artifact-list" aria-label="生成的文件">
      {artifacts.map((artifact) => {
        const detail =
          artifact.path === artifact.filename ?
            formatBytes(artifact.sizeBytes)
          : `${artifact.path} · ${formatBytes(artifact.sizeBytes)}`;
        return (
          <a
            className="artifact-card"
            download={artifact.filename}
            href={artifact.downloadUrl}
            key={artifact.id}
          >
            <span className="artifact-icon" aria-hidden="true">
              <FileText size={18} />
            </span>
            <span className="artifact-copy">
              <strong>{artifact.filename}</strong>
              <span>{detail}</span>
            </span>
            <span className="artifact-download" aria-hidden="true">
              <Download size={17} />
            </span>
          </a>
        );
      })}
    </div>
  );
}

function TaskStatusIcon({ status }: { status: AgentTaskSummary["status"] }) {
  if (status === "completed") {
    return <Check size={15} />;
  }
  if (status === "failed" || status === "cancelled" || status === "interrupted") {
    return <X size={15} />;
  }
  if (status === "running") {
    return <Activity size={15} />;
  }
  return <CircleStop size={15} />;
}

function TaskPanel({
  expanded,
  onToggle,
  syncedAt,
  tasks,
}: {
  expanded: boolean;
  onToggle: () => void;
  syncedAt: string | null;
  tasks: TaskCardState[];
}) {
  if (tasks.length === 0) {
    return null;
  }

  const subagents = tasks.filter((task) => task.kind === "subagent");
  const tracked = subagents.length > 0 ? subagents : tasks;
  const activeCount = tracked.filter(taskIsActive).length;
  const completedCount = tracked.filter((task) => task.status === "completed").length;
  const attentionCount = tracked.filter(taskNeedsAttention).length;
  const progress =
    tracked.length > 0 ? Math.round((completedCount / tracked.length) * 100) : 0;
  const headline =
    subagents.length > 0 ?
      `后台子代理 ${completedCount}/${tracked.length} 完成`
    : `任务 ${completedCount}/${tracked.length} 完成`;
  const summary =
    activeCount > 0 ? `${activeCount} 个仍在后台运行`
    : attentionCount > 0 ? `${attentionCount} 个需要关注`
    : "所有后台工作已收束";
  const panelState =
    activeCount > 0 ? "active"
    : attentionCount > 0 ? "attention"
    : "complete";

  return (
    <div className={`task-panel ${panelState} ${expanded ? "expanded" : "collapsed"}`} aria-label="任务状态">
      <div className="task-panel-header">
        <span className="task-panel-pulse" aria-hidden="true" />
        <span className="task-panel-title">
          <strong>{headline}</strong>
          <span>{summary}</span>
        </span>
        <span className="task-panel-sync">{formatSyncedAt(syncedAt)}</span>
        <button
          aria-label={expanded ? "收起后台任务详情" : "展开后台任务详情"}
          className="task-panel-toggle"
          onClick={onToggle}
          title={expanded ? "收起后台任务详情" : "展开后台任务详情"}
          type="button"
        >
          <ChevronDown size={16} />
        </button>
      </div>
      <div className="task-progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
      {expanded && (
        <div className="task-panel-details">
          {tasks.map((task) => {
            const detail =
              task.status === "completed" ?
                task.resultPreview || "已完成，结果已写回当前会话"
              : taskNeedsAttention(task) ?
                task.error || "任务没有正常完成"
              : task.lastActivity ||
                task.activeForm ||
                (task.kind === "subagent" ? "正在后台运行，当前对话可继续" : "") ||
                task.description ||
                task.goal ||
                "";
            const duration = formatTaskDuration(task);
            return (
              <div className={`task-card ${task.kind} ${task.status}`} key={task.id}>
                <span className="task-card-icon" aria-hidden="true">
                  <TaskStatusIcon status={task.status} />
                </span>
                <span className="task-card-copy">
                  <span className="task-card-head">
                    <strong>{task.subject}</strong>
                    <span>{task.kind === "subagent" ? "后台子代理" : "主线任务"}</span>
                  </span>
                  {detail && <small>{detail}</small>}
                  <span className="task-card-meta">
                    <span>{taskStatusLabel(task.status)}</span>
                    <span>{shortTaskId(task.id)}</span>
                    {task.childRunId && <span>run {shortRunId(task.childRunId)}</span>}
                    {duration && <span>{duration}</span>}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type AskQuestionDraft = {
  notes: string;
  other: string;
  selectedLabels: string[];
};

function emptyQuestionDraft(): AskQuestionDraft {
  return {
    notes: "",
    other: "",
    selectedLabels: [],
  };
}

function initialQuestionDrafts(request: AskUserQuestionRequest) {
  return Object.fromEntries(
    request.questions.map((question) => [question.question, emptyQuestionDraft()]),
  ) as Record<string, AskQuestionDraft>;
}

function questionDraft(
  drafts: Record<string, AskQuestionDraft>,
  question: AskUserQuestion,
) {
  return drafts[question.question] ?? emptyQuestionDraft();
}

function questionHasAnswer(
  drafts: Record<string, AskQuestionDraft>,
  question: AskUserQuestion,
) {
  const draft = questionDraft(drafts, question);
  return draft.selectedLabels.length > 0 || draft.other.trim().length > 0;
}

function buildQuestionResponse(
  request: AskUserQuestionRequest,
  drafts: Record<string, AskQuestionDraft>,
): AskUserQuestionResponse {
  const answers: AskUserQuestionResponse["answers"] = {};
  const annotations: NonNullable<AskUserQuestionResponse["annotations"]> = {};

  for (const question of request.questions) {
    const draft = questionDraft(drafts, question);
    const custom = draft.other.trim();
    const selected = draft.selectedLabels.filter(Boolean);
    const answerParts = question.multiSelect ?
      [...selected, ...(custom ? [custom] : [])]
    : [custom || selected[0] || ""];
    const answer = answerParts.join(", ").trim();
    answers[question.question] = answer;

    const preview = question.options
      .filter((option) => selected.includes(option.label) && option.preview)
      .map((option) => option.preview)
      .join("\n\n")
      .trim();
    const notes = draft.notes.trim();
    if (preview || notes) {
      annotations[question.question] = {
        ...(notes ? { notes } : {}),
        ...(preview ? { preview } : {}),
      };
    }
  }

  return {
    answers,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
  };
}

function AskUserQuestionApproval({
  approval,
  onApprove,
  onReject,
  request,
}: {
  approval: PendingApproval;
  onApprove: (approval: PendingApproval, response: AskUserQuestionResponse) => void;
  onReject: (approval: PendingApproval) => void;
  request: AskUserQuestionRequest;
}) {
  const [drafts, setDrafts] = useState<Record<string, AskQuestionDraft>>(() =>
    initialQuestionDrafts(request),
  );

  const allAnswered = request.questions.every((question) =>
    questionHasAnswer(drafts, question),
  );
  const submitting = approval.state === "submitting";
  const questionCountLabel =
    request.questions.length === 1 ? "1 个问题" : `${request.questions.length} 个问题`;
  const hasMultiSelect = request.questions.some((question) => question.multiSelect);

  function updateDraft(question: AskUserQuestion, update: (draft: AskQuestionDraft) => AskQuestionDraft) {
    setDrafts((current) => {
      const currentDraft = questionDraft(current, question);
      return {
        ...current,
        [question.question]: update(currentDraft),
      };
    });
  }

  return (
    <div className="question-approval" key={approval.approvalId}>
      <div className="question-approval-head">
        <span className="question-status-dot" aria-hidden="true" />
        <span className="question-approval-copy">
          <strong>需要你的选择</strong>
          <span>{approval.reason}</span>
        </span>
        <span className="question-approval-meta">
          <span>{questionCountLabel}</span>
          {hasMultiSelect && <span>可多选</span>}
        </span>
        <button
          aria-label={`拒绝 ${approval.toolName}`}
          className="approval-action question-reject-button reject"
          disabled={submitting}
          onClick={() => onReject(approval)}
          title="拒绝"
          type="button"
        >
          <X size={16} />
        </button>
      </div>

      {request.questions.map((question, questionIndex) => {
        const draft = questionDraft(drafts, question);
        const selectedPreviews = question.options.filter(
          (option) => draft.selectedLabels.includes(option.label) && option.preview,
        );

        return (
          <div className="question-block" key={`${question.question}-${questionIndex}`}>
            <div className="question-block-head">
              <span className="question-index">
                {questionIndex + 1}/{request.questions.length}
              </span>
              <span className="question-kicker">{question.header}</span>
              {question.multiSelect && <span className="question-mode">多选</span>}
            </div>
            <strong className="question-title">{question.question}</strong>
            <div className="question-options">
              {question.options.map((option) => {
                const checked = draft.selectedLabels.includes(option.label);
                return (
                  <label
                    className={`question-option ${checked ? "selected" : ""}`}
                    key={option.label}
                  >
                    <input
                      checked={checked}
                      disabled={submitting}
                      name={`${approval.approvalId}-${questionIndex}`}
                      onChange={(event) => {
                        const isChecked = event.target.checked;
                        updateDraft(question, (currentDraft) => {
                          if (question.multiSelect) {
                            const selectedLabels =
                              isChecked ?
                                Array.from(
                                  new Set([...currentDraft.selectedLabels, option.label]),
                                )
                              : currentDraft.selectedLabels.filter(
                                  (label) => label !== option.label,
                                );
                            return { ...currentDraft, selectedLabels };
                          }

                          return {
                            ...currentDraft,
                            other: "",
                            selectedLabels: isChecked ? [option.label] : [],
                          };
                        });
                      }}
                      type={question.multiSelect ? "checkbox" : "radio"}
                    />
                    <span className="question-option-marker" aria-hidden="true">
                      {checked && <Check size={12} />}
                    </span>
                    <span className="question-option-copy">
                      <strong>{option.label}</strong>
                      <span>{option.description}</span>
                    </span>
                  </label>
                );
              })}
              <label className={`question-option other ${draft.other.trim() ? "selected" : ""}`}>
                <span className="question-option-marker" aria-hidden="true">
                  {draft.other.trim() ? <Check size={12} /> : null}
                </span>
                <span className="question-option-copy">
                  <strong>其他</strong>
                  <input
                    disabled={submitting}
                    onChange={(event) => {
                      const nextOther = event.target.value;
                      updateDraft(question, (currentDraft) => ({
                        ...currentDraft,
                        other: nextOther,
                        selectedLabels:
                          question.multiSelect || nextOther.trim().length === 0 ?
                            currentDraft.selectedLabels
                          : [],
                      }));
                    }}
                    placeholder="填写其他答案"
                    type="text"
                    value={draft.other}
                  />
                </span>
              </label>
            </div>
            {selectedPreviews.length > 0 && (
              <div className="question-previews">
                {selectedPreviews.map((option) => (
                  <pre key={option.label}>{option.preview}</pre>
                ))}
              </div>
            )}
            <textarea
              className="question-notes"
              disabled={submitting}
              onChange={(event) => {
                const notes = event.target.value;
                updateDraft(question, (currentDraft) => ({ ...currentDraft, notes }));
              }}
              placeholder="备注，可选"
              rows={2}
              value={draft.notes}
            />
          </div>
        );
      })}

      <div className="question-approval-footer">
        <span className="question-submit-hint">
          {allAnswered ? "已可提交" : "每个问题都需要一个答案"}
        </span>
        <button
          className="question-submit"
          disabled={!allAnswered || submitting}
          onClick={() => onApprove(approval, buildQuestionResponse(request, drafts))}
          type="button"
        >
          <Check size={16} />
          提交选择
        </button>
      </div>
    </div>
  );
}

function MarkdownMessage({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  return (
    <Streamdown
      className="markdown-content"
      controls={{
        code: {
          copy: true,
          download: false,
        },
        mermaid: false,
        table: false,
      }}
      dir="auto"
      isAnimating={isStreaming}
      lineNumbers={false}
      mode={isStreaming ? "streaming" : "static"}
      normalizeHtmlIndentation
      parseIncompleteMarkdown={isStreaming}
      plugins={{ code: streamdownCode }}
      shikiTheme={["github-light", "github-light"]}
      skipHtml
      translations={{
        copied: "已复制",
        copyCode: "复制代码",
      }}
    >
      {content || " "}
    </Streamdown>
  );
}

export function ChatWorkspace() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [appEnvironment, setAppEnvironment] =
    useState<AuthUser["environment"]>("dev");
  const [inviteCode, setInviteCode] = useState("");
  const [userIdentifier, setUserIdentifier] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [monitorConnection, setMonitorConnection] =
    useState<MonitorConnection>("connecting");
  const [serviceSnapshot, setServiceSnapshot] =
    useState<ServiceHealthSnapshot | null>(null);
  const [consoleLogs, setConsoleLogs] = useState<ServiceConsoleLog[]>([]);
  const [activeRun, setActiveRun] = useState<ActiveRunState | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [agentTasks, setAgentTasks] = useState<TaskCardState[]>([]);
  const [taskPanelExpanded, setTaskPanelExpanded] = useState(false);
  const [taskSyncedAt, setTaskSyncedAt] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const autoScrollRef = useRef(true);
  const isAtBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const taskRefreshInFlightRef = useRef(false);
  const taskCompletionSignatureRef = useRef("");
  const touchStartYRef = useRef<number | null>(null);
  const userDetachedFromBottomRef = useRef(false);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(
      textarea.scrollHeight,
      COMPOSER_TEXTAREA_MAX_HEIGHT,
    )}px`;
  }, [input]);

  const sessionLabel = useMemo(
    () => (sessionId ? `当前会话 ${shortSessionId(sessionId)}` : "尚未创建会话"),
    [sessionId],
  );
  const checkedAtLabel = serviceSnapshot ?
    `最近检查 ${formatConsoleTime(serviceSnapshot.checkedAt)}`
  : "等待第一条快照";
  const overallStatusLabel = serviceSnapshot ?
    healthStatusLabel(serviceSnapshot.status)
  : "建立监听";
  const hasActiveSubagentTasks = useMemo(
    () => agentTasks.some((task) => task.kind === "subagent" && taskIsActive(task)),
    [agentTasks],
  );

  const appendConsoleLog = useCallback(
    (log: Omit<ServiceConsoleLog, "id"> & { id?: string }) => {
      const id = log.id ?? crypto.randomUUID();

      setConsoleLogs((current) =>
        [
          {
            id,
            at: log.at,
            level: log.level,
            source: log.source,
            message: log.message,
          },
          ...current,
        ].slice(0, MAX_CONSOLE_LOGS),
      );
    },
    [],
  );

  const updateBottomState = useCallback(
    (isAtBottom: boolean) => {
      isAtBottomRef.current = isAtBottom;

      if (isAtBottom && !userDetachedFromBottomRef.current) {
        autoScrollRef.current = true;
      }

      setShowScrollToBottom(
        messages.length > 0 && (!isAtBottom || userDetachedFromBottomRef.current),
      );
    },
    [messages.length],
  );

  const markManualScrollAway = useCallback(() => {
    const element = messagesRef.current;

    if (
      messages.length === 0 ||
      !element ||
      element.scrollHeight <= element.clientHeight
    ) {
      return;
    }

    userDetachedFromBottomRef.current = true;
    autoScrollRef.current = false;
    setShowScrollToBottom(true);
  }, [messages.length]);

  const updateScrollStateFromDistance = useCallback(() => {
    const element = messagesRef.current;

    if (!element || messages.length === 0) {
      autoScrollRef.current = true;
      isAtBottomRef.current = true;
      lastScrollTopRef.current = 0;
      userDetachedFromBottomRef.current = false;
      setShowScrollToBottom(false);
      return;
    }

    const previousScrollTop = lastScrollTopRef.current;
    const nextScrollTop = element.scrollTop;
    const distanceToBottom =
      element.scrollHeight - nextScrollTop - element.clientHeight;
    const isAtBottom = distanceToBottom <= SCROLL_BOTTOM_FALLBACK_THRESHOLD;
    const isScrollingUp = nextScrollTop < previousScrollTop - 2;
    const isScrollingDown = nextScrollTop > previousScrollTop + 2;

    if (isScrollingUp && !isAtBottom) {
      userDetachedFromBottomRef.current = true;
      autoScrollRef.current = false;
      setShowScrollToBottom(true);
    } else if (isAtBottom && isScrollingDown) {
      userDetachedFromBottomRef.current = false;
      updateBottomState(true);
    } else {
      updateBottomState(isAtBottom);
    }
    lastScrollTopRef.current = nextScrollTop;
  }, [messages.length, updateBottomState]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = messagesRef.current;

    userDetachedFromBottomRef.current = false;
    autoScrollRef.current = true;
    isAtBottomRef.current = true;

    element?.scrollTo({
      top: element.scrollHeight,
      behavior,
    });
    setShowScrollToBottom(false);
  }, []);

  const clearWorkspace = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setSessions([]);
    setConsoleLogs([]);
    setActiveRun(null);
    setPendingApprovals([]);
    setAgentTasks([]);
    setTaskPanelExpanded(false);
    setTaskSyncedAt(null);
    setMonitorConnection("connecting");
    setServiceSnapshot(null);
    autoScrollRef.current = true;
    isAtBottomRef.current = true;
    lastScrollTopRef.current = 0;
    taskCompletionSignatureRef.current = "";
    userDetachedFromBottomRef.current = false;
    setShowScrollToBottom(false);
  }, []);

  const handleUnauthorized = useCallback(() => {
    setAuthStatus("anonymous");
    setAuthUser(null);
    clearWorkspace();
    setLoginError("登录已过期，请重新输入内测码");
  }, [clearWorkspace]);

  const refreshSessions = useCallback(async () => {
    const response = await fetch("/api/chat/sessions");

    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    if (!response.ok) {
      throw new Error(String(response.status));
    }

    const body = (await response.json()) as {
      environment: AuthUser["environment"];
      sessions: ChatSession[];
    };
    setAppEnvironment(body.environment);
    setSessions(body.sessions);
  }, [handleUnauthorized]);

  const refreshCurrentSessionMessages = useCallback(async () => {
    if (!sessionId || isStreaming) {
      return;
    }

    const response = await fetch(
      `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    );

    if (response.status === 401) {
      handleUnauthorized();
      return;
    }

    if (!response.ok) {
      throw new Error(String(response.status));
    }

    const body = (await response.json()) as {
      messages: ChatMessagePayload[];
      session: { id: string };
    };
    const nextMessages = toChatMessages(body.messages);
    const shouldScroll = isAtBottomRef.current && !userDetachedFromBottomRef.current;

    setSessionId(body.session.id);
    setMessages((current) =>
      messagesChanged(current, nextMessages) ? nextMessages : current,
    );

    if (shouldScroll) {
      requestAnimationFrame(() => scrollToBottom("smooth"));
    }
  }, [handleUnauthorized, isStreaming, scrollToBottom, sessionId]);

  const refreshSessionTasks = useCallback(
    async (input: { refreshMessagesOnCompletion?: boolean } = {}) => {
      if (!sessionId || taskRefreshInFlightRef.current) {
        return;
      }

      taskRefreshInFlightRef.current = true;
      try {
        const response = await fetch(
          `/api/agent/sessions/${encodeURIComponent(sessionId)}/tasks`,
        );

        if (response.status === 401) {
          handleUnauthorized();
          return;
        }

        if (response.status === 404) {
          setAgentTasks([]);
          setTaskSyncedAt(new Date().toISOString());
          return;
        }

        if (!response.ok) {
          throw new Error(String(response.status));
        }

        const body = (await response.json()) as {
          session: { id: string };
          tasks: AgentTaskSummary[];
        };
        const tasks = sortTaskCards(body.tasks);
        const completedSignature = tasks
          .filter(
            (task) =>
              task.kind === "subagent" &&
              !taskIsActive(task) &&
              (task.resultPreview || task.error || task.completedAt),
          )
          .map((task) => `${task.id}:${task.status}:${task.updatedAt}`)
          .join("|");

        setSessionId(body.session.id);
        setAgentTasks(tasks);
        setTaskSyncedAt(new Date().toISOString());

        if (
          input.refreshMessagesOnCompletion &&
          completedSignature &&
          completedSignature !== taskCompletionSignatureRef.current
        ) {
          taskCompletionSignatureRef.current = completedSignature;
          await refreshCurrentSessionMessages();
        }
      } catch (error) {
        appendConsoleLog({
          at: new Date().toISOString(),
          level: "warn",
          source: "task",
          message:
            error instanceof Error ? `任务状态同步失败：${error.message}` : "任务状态同步失败",
        });
      } finally {
        taskRefreshInFlightRef.current = false;
      }
    },
    [appendConsoleLog, handleUnauthorized, refreshCurrentSessionMessages, sessionId],
  );

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    void refreshSessionTasks({ refreshMessagesOnCompletion: true });
  }, [refreshSessionTasks, sessionId]);

  useEffect(() => {
    if (!sessionId || (!activeRun && !isStreaming && !hasActiveSubagentTasks)) {
      return;
    }

    const interval = window.setInterval(() => {
      void refreshSessionTasks({ refreshMessagesOnCompletion: true });
    }, 2000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeRun, hasActiveSubagentTasks, isStreaming, refreshSessionTasks, sessionId]);

  useEffect(() => {
    const element = messagesRef.current;

    if (!element) {
      return;
    }

    const target = messagesEndRef.current;
    updateScrollStateFromDistance();
    element.addEventListener("scroll", updateScrollStateFromDistance, {
      passive: true,
    });

    if (!target || !("IntersectionObserver" in window)) {
      return () => {
        element.removeEventListener("scroll", updateScrollStateFromDistance);
      };
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) {
          return;
        }

        updateBottomState(entry.isIntersecting);
      },
      {
        root: element,
        rootMargin: SCROLL_BOTTOM_ROOT_MARGIN,
        threshold: 0,
      },
    );

    observer.observe(target);

    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", updateScrollStateFromDistance);
    };
  }, [updateBottomState, updateScrollStateFromDistance]);

  useEffect(() => {
    if (!autoScrollRef.current) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      scrollToBottom("auto");
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [messages, scrollToBottom]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrapAuth() {
      try {
        const response = await fetch("/api/auth/me");

        if (cancelled) {
          return;
        }

        if (response.status === 401) {
          const body = (await response.json().catch(() => null)) as {
            environment?: AuthUser["environment"];
          } | null;
          if (body?.environment) {
            setAppEnvironment(body.environment);
          }
          setAuthStatus("anonymous");
          setAuthUser(null);
          return;
        }

        if (!response.ok) {
          throw new Error(String(response.status));
        }

        const body = (await response.json()) as {
          environment: AuthUser["environment"];
          user: AuthUser;
        };
        setAppEnvironment(body.environment);
        setAuthUser(body.user);
        setAuthStatus("authenticated");
        await refreshSessions();
      } catch (error) {
        if (!cancelled) {
          setAuthStatus("anonymous");
          setLoginError(
            error instanceof Error ? `登录状态检查失败：${error.message}` : "登录状态检查失败",
          );
        }
      }
    }

    void bootstrapAuth();

    return () => {
      cancelled = true;
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (authStatus !== "authenticated") {
      return;
    }

    const source = new EventSource("/api/health/stream");

    const handleOpen = () => {
      setMonitorConnection("connected");
      appendConsoleLog({
        at: new Date().toISOString(),
        level: "info",
        source: "client",
        message: "控制台监听通道已连接",
      });
    };

    const handleError = () => {
      setMonitorConnection("disconnected");
      appendConsoleLog({
        at: new Date().toISOString(),
        level: "error",
        source: "client",
        message: "控制台监听通道断开，浏览器正在重连",
      });
    };

    const handleSnapshot = (event: Event) => {
      const payload = parseServiceEvent<ServiceSnapshotEvent>(event);

      if (!payload) {
        return;
      }

      setMonitorConnection("connected");
      setServiceSnapshot(payload.snapshot);
    };

    const handleLog = (event: Event) => {
      const payload = parseServiceEvent<ServiceLogEvent>(event);

      if (!payload) {
        return;
      }

      appendConsoleLog({
        id: `status-${payload.sequence}-${payload.at}`,
        at: payload.at,
        level: payload.level,
        source: payload.source,
        message: payload.message,
      });
    };

    const handleHeartbeat = () => {
      setMonitorConnection("connected");
    };

    source.onopen = handleOpen;
    source.onerror = handleError;
    source.addEventListener("status.snapshot", handleSnapshot);
    source.addEventListener("status.log", handleLog);
    source.addEventListener("status.heartbeat", handleHeartbeat);

    return () => {
      source.close();
    };
  }, [appendConsoleLog, authStatus]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const code = inviteCode.trim();
    const loginId = userIdentifier.trim();
    if (!code || !loginId || isLoggingIn) {
      return;
    }

    setIsLoggingIn(true);
    setLoginError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim() || undefined,
          inviteCode: code,
          userIdentifier: loginId,
        }),
      });

      const body = (await response.json()) as {
        environment?: AuthUser["environment"];
        error?: string;
        user?: AuthUser;
      };

      if (body.environment) {
        setAppEnvironment(body.environment);
      }

      if (!response.ok || !body.user) {
        throw new Error(body.error ?? `登录失败：${response.status}`);
      }

      setAuthUser(body.user);
      setAuthStatus("authenticated");
      setInviteCode("");
      setUserIdentifier("");
      setDisplayName("");
      clearWorkspace();
      await refreshSessions();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function logout() {
    stopStreaming();
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthStatus("anonymous");
    setAuthUser(null);
    clearWorkspace();
  }

  function startNewChat() {
    stopStreaming();
    autoScrollRef.current = true;
    isAtBottomRef.current = true;
    lastScrollTopRef.current = 0;
    taskCompletionSignatureRef.current = "";
    userDetachedFromBottomRef.current = false;
    setMessages([]);
    setSessionId(null);
    setAgentTasks([]);
    setTaskPanelExpanded(false);
    setTaskSyncedAt(null);
    setShowScrollToBottom(false);
  }

  async function openSession(nextSessionId: string) {
    if (nextSessionId === sessionId || isLoadingSession) {
      return;
    }

    stopStreaming();
    setIsLoadingSession(true);

    try {
      const response = await fetch(
        `/api/chat/sessions/${encodeURIComponent(nextSessionId)}/messages`,
      );

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      if (!response.ok) {
        throw new Error(String(response.status));
      }

      const body = (await response.json()) as {
        messages: ChatMessagePayload[];
        session?: { id: string };
      };

      setSessionId(body.session?.id ?? nextSessionId);
      setAgentTasks([]);
      setTaskPanelExpanded(false);
      setTaskSyncedAt(null);
      taskCompletionSignatureRef.current = "";
      autoScrollRef.current = true;
      isAtBottomRef.current = true;
      lastScrollTopRef.current = 0;
      userDetachedFromBottomRef.current = false;
      setMessages(toChatMessages(body.messages));
    } catch (error) {
      appendConsoleLog({
        at: new Date().toISOString(),
        level: "error",
        source: "client",
        message:
          error instanceof Error ? `加载会话失败：${error.message}` : "加载会话失败",
      });
    } finally {
      setIsLoadingSession(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const prompt = input.trim();
    if (!prompt || isStreaming || authStatus !== "authenticated") {
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
    };
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      status: "streaming",
    };

    setInput("");
    autoScrollRef.current = true;
    isAtBottomRef.current = true;
    userDetachedFromBottomRef.current = false;
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setActiveRun(null);
    setPendingApprovals([]);
    if (!sessionId) {
      setAgentTasks([]);
      setTaskPanelExpanded(false);
      setTaskSyncedAt(null);
      taskCompletionSignatureRef.current = "";
    }
    setIsStreaming(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch("/api/agent/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxTokens: 8192,
          message: prompt,
          ...(sessionId ? { sessionId } : {}),
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        if (response.status === 401) {
          handleUnauthorized();
        }
        throw new Error(String(response.status));
      }

      if (!response.body) {
        throw new Error("Missing response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const eventText of events) {
          const event = parseSseEvent(eventText);

          if (!event) {
            continue;
          }

          if (event.type === "run.accepted") {
            setSessionId(event.sessionId);
            setActiveRun({
              queueMode: event.queueMode,
              runId: event.runId,
              sessionId: event.sessionId,
              status: "accepted",
            });
            void refreshSessions();
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "agent",
              message: `运行已接收 ${shortRunId(event.runId)}`,
            });
          }

          if (event.type === "run.started") {
            setActiveRun((current) =>
              current?.runId === event.runId ?
                { ...current, status: "running" }
              : current,
            );
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "agent",
              message: `模型流开始 ${shortRunId(event.runId)}`,
            });
          }

          if (event.type === "context.built") {
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "agent",
              message: `上下文已构建，约 ${event.tokenEstimate} tokens`,
            });
          }

          if (event.type === "system.reminder.persisted") {
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "agent",
              message: event.sanitized ? "系统提醒已固化，用户控制标记已净化" : "系统提醒已固化",
            });
          }

          if (event.type === "context.compaction.started") {
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "agent",
              message:
                event.reason === "reactive" ?
                  "上下文过长，开始恢复性压缩"
                : "开始压缩上下文",
            });
          }

          if (event.type === "context.compacted") {
            if (event.sessionId) {
              const compactedSessionId = event.sessionId;
              setSessionId(compactedSessionId);
              setActiveRun((current) =>
                current ? { ...current, sessionId: compactedSessionId } : current,
              );
              void refreshSessions();
            }
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "agent",
              message: `上下文已压缩，折叠 ${event.compactedMessageCount} 条历史`,
            });
          }

          if (event.type === "payload.sanitized") {
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "warn",
              source: "agent",
              message: `模型载荷已修复：补 ${event.insertedMissingToolResults}、移除 ${event.removedOrphanToolResults}`,
            });
          }

          if (event.type === "protocol.recovery") {
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "warn",
              source: "agent",
              message:
                event.toolName ?
                  `模型协议恢复重试：${event.toolName}`
                : "模型协议恢复重试",
            });
          }

          if (event.type === "assistant.delta") {
            setMessages((current) =>
              appendMessageContent(current, assistantMessage.id, event.text),
            );
          }

          if (event.type === "assistant.delta.retracted") {
            setMessages((current) =>
              retractMessageContent(current, assistantMessage.id, event.text),
            );
          }

          if (event.type === "reasoning.delta") {
            setMessages((current) =>
              appendMessageReasoning(current, assistantMessage.id, event.text),
            );
          }

          if (event.type === "tool.started") {
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "tool",
              message: `工具开始 ${event.toolName}`,
            });
          }

          if (event.type === "tool.approval.required") {
            setActiveRun((current) =>
              current?.runId === event.runId ?
                { ...current, status: "waiting_approval" }
              : current,
            );
            setPendingApprovals((current) => {
              const nextApproval: PendingApproval = {
                approvalId: event.approvalId,
                reason: event.reason,
                request: event.request,
                risk: event.risk,
                runId: event.runId,
                state: "pending",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              };

              if (current.some((approval) => approval.approvalId === event.approvalId)) {
                return current.map((approval) =>
                  approval.approvalId === event.approvalId ? nextApproval : approval,
                );
              }

              return [...current, nextApproval];
            });
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "warn",
              source: "tool",
              message: `工具需要确认 ${event.toolName}：${event.reason}`,
            });
          }

          if (event.type === "tool.question.required") {
            setActiveRun((current) =>
              current?.runId === event.runId ?
                { ...current, status: "waiting_approval" }
              : current,
            );
            setPendingApprovals((current) => {
              const nextApproval: PendingApproval = {
                approvalId: event.questionId,
                reason: event.message,
                request: event.request,
                risk: "read",
                runId: event.runId,
                state: "pending",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              };

              if (current.some((approval) => approval.approvalId === event.questionId)) {
                return current.map((approval) =>
                  approval.approvalId === event.questionId ? nextApproval : approval,
                );
              }

              return [...current, nextApproval];
            });
          }

          if (event.type === "tool.confirmation.required") {
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "warn",
              source: "tool",
              message: `等待确认 ${event.toolName}：${event.message}`,
            });
          }

          if (event.type === "tool.approval.resolved") {
            setPendingApprovals((current) =>
              current.filter((approval) => approval.approvalId !== event.approvalId),
            );
            setActiveRun((current) =>
              current?.runId === event.runId ? { ...current, status: "running" } : current,
            );
          }

          if (event.type === "tool.completed") {
            setPendingApprovals((current) =>
              current.filter((approval) => approval.toolCallId !== event.toolCallId),
            );
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "tool",
              message: `工具完成 ${event.toolName}`,
            });
          }

          if (event.type === "artifact.created") {
            setMessages((current) =>
              appendMessageArtifact(current, assistantMessage.id, event.artifact),
            );
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "artifact",
              message: `文件已生成 ${event.artifact.filename}`,
            });
          }

          if (event.type === "tool.failed") {
            setPendingApprovals((current) =>
              current.filter((approval) => approval.toolCallId !== event.toolCallId),
            );
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "warn",
              source: "tool",
              message: `工具失败 ${event.toolName}：${event.error}`,
            });
          }

          const taskUpdate = taskEventUpdate(event);
          if (taskUpdate) {
            setAgentTasks((current) => upsertTaskCard(current, taskUpdate));
            setTaskSyncedAt(new Date().toISOString());
            if (event.type === "task.created") {
              appendConsoleLog({
                at: new Date().toISOString(),
                level: "info",
                source: "task",
                message: `任务已创建 ${taskUpdate.task.subject}`,
              });
            }
            if (event.type === "task.completed" || event.type === "subagent.completed") {
              appendConsoleLog({
                at: new Date().toISOString(),
                level: "info",
                source: "task",
                message: `任务完成 ${taskUpdate.task.subject}`,
              });
            }
            if (
              event.type === "task.failed" ||
              event.type === "task.cancelled" ||
              event.type === "subagent.failed"
            ) {
              appendConsoleLog({
                at: new Date().toISOString(),
                level: "warn",
                source: "task",
                message: `${taskStatusLabel(taskUpdate.task.status)} ${taskUpdate.task.subject}`,
              });
            }
          }

          if (event.type === "run.completed") {
            setActiveRun((current) => (current?.runId === event.runId ? null : current));
            setPendingApprovals((current) =>
              current.filter((approval) => approval.runId !== event.runId),
            );
            void refreshSessions();
            void refreshSessionTasks({ refreshMessagesOnCompletion: true });
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "agent",
              message: `运行完成 ${shortRunId(event.runId)}`,
            });
            setMessages((current) => {
              const assistant = current.find(
                (message) => message.id === assistantMessage.id,
              );
              return updateMessage(
                current,
                assistantMessage.id,
                {
                  content:
                    assistant?.content.trim() ?
                      assistant.content
                    : assistant?.artifacts?.length ?
                      "文件已生成，可以直接下载。"
                    : "没有收到模型回复，请再试一次。",
                  status: "complete",
                },
              );
            });
          }

          if (event.type === "run.failed") {
            setActiveRun((current) => (current?.runId === event.runId ? null : current));
            setPendingApprovals((current) =>
              current.filter((approval) => approval.runId !== event.runId),
            );
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "error",
              source: "agent",
              message: `运行失败 ${shortRunId(event.runId)}：${event.error}`,
            });
            setMessages((current) =>
              updateMessage(
                current,
                assistantMessage.id,
                {
                  content: `请求失败：${event.error}`,
                  status: "failed",
                },
              ),
            );
          }

          if (event.type === "run.aborted") {
            setActiveRun((current) => (current?.runId === event.runId ? null : current));
            setPendingApprovals((current) =>
              current.filter((approval) => approval.runId !== event.runId),
            );
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "warn",
              source: "agent",
              message: `运行已停止 ${shortRunId(event.runId)}`,
            });
            setMessages((current) => {
              const assistant = current.find(
                (message) => message.id === assistantMessage.id,
              );
              return updateMessage(current, assistantMessage.id, {
                content: assistant?.content.trim() ? assistant.content : "已停止。",
                status: "aborted",
              });
            });
          }
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        appendConsoleLog({
          at: new Date().toISOString(),
          level: "error",
          source: "agent",
          message:
            error instanceof Error ? `请求失败：${error.message}` : "请求失败。",
        });
        setMessages((current) =>
          updateMessage(
            current,
            assistantMessage.id,
            {
              content:
                error instanceof Error ? `请求失败：${error.message}` : "请求失败。",
              status: "failed",
            },
          ),
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  }

  async function copyMessage(message: ChatMessage) {
    const text = message.content.trim();
    if (!text) {
      return;
    }

    await navigator.clipboard.writeText(text);
    setCopiedMessageId(message.id);
    window.setTimeout(() => {
      setCopiedMessageId((current) => (current === message.id ? null : current));
    }, 1600);
  }

  async function resolveApproval(
    approval: PendingApproval,
    decision: "approved" | "rejected",
    approvalResponse?: AskUserQuestionResponse,
  ) {
    setPendingApprovals((current) =>
      current.map((item) =>
        item.approvalId === approval.approvalId ? { ...item, state: "submitting" } : item,
      ),
    );

    try {
      const response = await fetch(
        `/api/agent/approvals/${encodeURIComponent(approval.approvalId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            ...(approvalResponse ? { response: approvalResponse } : {}),
          }),
        },
      );

      if (response.status === 401) {
        handleUnauthorized();
        return;
      }

      if (!response.ok) {
        throw new Error(String(response.status));
      }

      appendConsoleLog({
        at: new Date().toISOString(),
        level: "info",
        source: "tool",
        message:
          decision === "approved" ?
            `已批准 ${approval.toolName}`
          : `已拒绝 ${approval.toolName}`,
      });
    } catch (error) {
      setPendingApprovals((current) =>
        current.map((item) =>
          item.approvalId === approval.approvalId ? { ...item, state: "pending" } : item,
        ),
      );
      appendConsoleLog({
        at: new Date().toISOString(),
        level: "error",
        source: "tool",
        message:
          error instanceof Error ? `审批提交失败：${error.message}` : "审批提交失败",
      });
    }
  }

  async function stopStreaming() {
    const runId = activeRun?.runId;

    if (runId) {
      setActiveRun((current) =>
        current?.runId === runId ? { ...current, status: "cancelling" } : current,
      );

      try {
        const response = await fetch(
          `/api/agent/runs/${encodeURIComponent(runId)}/cancel`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "user_cancelled" }),
          },
        );

        if (response.status === 401) {
          handleUnauthorized();
        } else if (!response.ok) {
          throw new Error(String(response.status));
        }
      } catch (error) {
        appendConsoleLog({
          at: new Date().toISOString(),
          level: "error",
          source: "agent",
          message:
            error instanceof Error ? `停止运行失败：${error.message}` : "停止运行失败",
        });
      }
    }

    abortControllerRef.current?.abort();
    setPendingApprovals((current) =>
      runId ? current.filter((approval) => approval.runId !== runId) : current,
    );
    setActiveRun((current) => (runId && current?.runId === runId ? null : current));
    setMessages((current) =>
      current.map((message) =>
        message.role === "assistant" && message.status === "streaming" ?
          {
            ...message,
            content: message.content.trim() ? message.content : "已停止。",
            status: "aborted",
          }
        : message,
      ),
    );
    setIsStreaming(false);
  }

  if (authStatus === "checking") {
    return (
      <main className="auth-shell">
        <div className="auth-panel">
          <div className="auth-kicker">{environmentLabel(appEnvironment)}</div>
          <h1>正在确认访问权限</h1>
          <div className="auth-loading" aria-label="加载中" />
        </div>
      </main>
    );
  }

  if (authStatus === "anonymous") {
    return (
      <main className="auth-shell">
        <form className="auth-panel" onSubmit={login}>
          <div className="auth-kicker">{environmentLabel(appEnvironment)}</div>
          <h1>内测访问</h1>
          <label className="auth-field">
            <span>内测码</span>
            <input
              autoComplete="one-time-code"
              autoFocus
              onChange={(event) => setInviteCode(event.target.value)}
              placeholder="输入内测码"
              type="password"
              value={inviteCode}
            />
          </label>
          <label className="auth-field">
            <span>用户 ID</span>
            <input
              autoComplete="username"
              onChange={(event) => setUserIdentifier(event.target.value)}
              placeholder="用于区分历史对话"
              type="text"
              value={userIdentifier}
            />
          </label>
          <label className="auth-field">
            <span>昵称</span>
            <input
              autoComplete="nickname"
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="可选"
              type="text"
              value={displayName}
            />
          </label>
          {loginError ?
            <p className="auth-error" role="alert">
              {loginError}
            </p>
          : null}
          <button className="auth-submit" disabled={isLoggingIn} type="submit">
            {isLoggingIn ? "验证中" : "进入"}
          </button>
        </form>
      </main>
    );
  }

  const consolePanel = (
    <section className="console-panel" aria-label="服务控制台">
      <div className="console-header">
        <span className="console-title">
          <Activity size={15} />
          控制台
        </span>
        <span className={`connection-pill ${monitorConnection}`}>
          {connectionLabel(monitorConnection)}
        </span>
      </div>

      <div className="console-summary">
        <span
          className={`status-light ${serviceSnapshot?.status ?? monitorConnection}`}
          aria-hidden="true"
        />
        <strong>{overallStatusLabel}</strong>
        <span>{checkedAtLabel}</span>
      </div>

      <div className="service-list">
        {serviceSnapshot ?
          serviceSnapshot.services.map((service) => (
            <div className="service-row" key={service.id}>
              <span
                className={`status-light ${service.state}`}
                title={serviceStateLabel(service.state)}
              />
              <span className="service-copy">
                <strong>{service.label}</strong>
                <span>
                  {service.message}
                  {service.detail ? ` · ${service.detail}` : ""}
                </span>
              </span>
            </div>
          ))
        : <div className="service-row">
            <span className="status-light connecting" aria-hidden="true" />
            <span className="service-copy">
              <strong>服务快照</strong>
              <span>正在建立监听</span>
            </span>
          </div>}
      </div>

      <div className="console-log-list" aria-live="polite">
        {consoleLogs.length > 0 ?
          consoleLogs.map((log) => (
            <div className={`console-log-entry ${log.level}`} key={log.id}>
              <time dateTime={log.at}>{formatConsoleTime(log.at)}</time>
              <span className="console-log-message">
                <span className="console-log-meta">
                  {log.source} · {logLevelLabel(log.level)}
                </span>
                <span className="console-log-text">{log.message}</span>
              </span>
            </div>
          ))
        : <p className="console-empty">等待服务事件</p>}
      </div>
    </section>
  );

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <strong>My Agent</strong>
          <button className="icon-button" aria-label="折叠侧栏">
            <PanelsLeftBottom size={18} />
          </button>
        </div>

        <nav className="nav-stack" aria-label="主导航">
          <button className="nav-item active" onClick={startNewChat} type="button">
            <Plus size={17} />
            新聊天
          </button>
          <button className="nav-item" type="button">
            <Search size={17} />
            搜索聊天
          </button>
          <button className="nav-item" type="button">
            <Library size={17} />
            库
          </button>
          <button className="nav-item" type="button">
            <MoreHorizontal size={17} />
            更多
          </button>
        </nav>

        <section className="chat-list">
          <p className="section-label">会话</p>
          {sessions.length > 0 ?
            sessions.map((chatSession) => (
              <button
                className={`chat-link ${chatSession.id === sessionId ? "active" : ""}`}
                disabled={isLoadingSession}
                key={chatSession.id}
                onClick={() => void openSession(chatSession.id)}
                type="button"
              >
                <strong>{chatSession.title}</strong>
                <span>
                  {chatSession.messageCount} 条 · {formatSessionTime(chatSession.updatedAt)}
                </span>
              </button>
            ))
          : <div className="sidebar-state">
              <strong>{sessionLabel}</strong>
              <span>{messages.length > 0 ? `${messages.length} 条消息` : "发送消息后开始"}</span>
            </div>}
        </section>

        <div className="account-row">
          <span className="avatar">{environmentLabel(authUser?.environment).slice(0, 1)}</span>
          <span className="account-details">
            <strong>{displayUserName(authUser)}</strong>
            <small>{environmentLabel(authUser?.environment)}</small>
          </span>
          <button
            className="icon-button account-logout"
            onClick={() => void logout()}
            type="button"
            aria-label="退出登录"
            title="退出登录"
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <section className="workspace">
        <div
          className="messages"
          aria-live="polite"
          onTouchMove={(event) => {
            const touchStartY = touchStartYRef.current;
            if (touchStartY === null) {
              return;
            }

            if (event.touches[0]?.clientY - touchStartY > 4) {
              markManualScrollAway();
            }
          }}
          onTouchStart={(event) => {
            touchStartYRef.current = event.touches[0]?.clientY ?? null;
          }}
          onWheel={(event) => {
            if (event.deltaY < 0) {
              markManualScrollAway();
            }
          }}
          ref={messagesRef}
        >
          {messages.length === 0 ? (
            <div className="empty-state">
              <h1>今天想做什么？</h1>
            </div>
          ) : (
            messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-body">
                  {message.role === "assistant" && message.reasoningContent?.trim() && (
                    <details className="message-reasoning">
                      <summary>
                        <ChevronDown size={14} aria-hidden="true" />
                        <span>思考</span>
                      </summary>
                      <div className="message-reasoning-content">
                        {message.reasoningContent}
                      </div>
                    </details>
                  )}
                  {message.role === "assistant" &&
                  message.status === "streaming" &&
                  !message.content.trim() ?
                    <div
                      className="message-thinking"
                      aria-label="思考中"
                      data-text="思考中"
                    >
                      思考中
                    </div>
                  : <div className="message-content">
                      {message.role === "assistant" ?
                        <MarkdownMessage
                          content={message.content}
                          isStreaming={message.status === "streaming"}
                        />
                      : message.content || " "}
                    </div>}
                  {message.role === "assistant" && (
                    <ArtifactList artifacts={message.artifacts} />
                  )}
                  {message.role === "assistant" &&
                    message.status !== "streaming" &&
                    message.content.trim() && (
                      <div className="message-actions">
                        <button
                          className="message-action-button"
                          type="button"
                          aria-label="复制回答"
                          title="复制回答"
                          onClick={() => void copyMessage(message)}
                        >
                          {copiedMessageId === message.id ?
                            <Check size={17} />
                          : <Copy size={17} />}
                        </button>
                      </div>
                    )}
                </div>
              </article>
            ))
          )}
          <div
            aria-hidden="true"
            className="messages-bottom-sentinel"
            ref={messagesEndRef}
          />
        </div>

        {showScrollToBottom && (
          <button
            aria-label="回到最新消息"
            className="scroll-bottom-button"
            onClick={() => scrollToBottom()}
            title="回到最新消息"
            type="button"
          >
            <ChevronDown size={22} />
          </button>
        )}

        <div className="composer-stack">
          {(activeRun || pendingApprovals.length > 0 || agentTasks.length > 0) && (
            <section className="run-panel" aria-label="运行状态">
              {activeRun && (
                <div className="run-status-row">
                  <span className={`run-status-dot ${activeRun.status}`} aria-hidden="true" />
                  <span className="run-status-copy">
                    <strong>运行 {shortRunId(activeRun.runId)}</strong>
                    <span>{runStatusLabel(activeRun.status)}</span>
                  </span>
                </div>
              )}
              <TaskPanel
                expanded={taskPanelExpanded}
                onToggle={() => setTaskPanelExpanded((current) => !current)}
                syncedAt={taskSyncedAt}
                tasks={agentTasks}
              />
              {pendingApprovals.map((approval) => {
                const questionRequest = askUserQuestionRequestFromApproval(approval.request);
                if (questionRequest) {
                  return (
                    <AskUserQuestionApproval
                      approval={approval}
                      key={approval.approvalId}
                      onApprove={(approvalItem, response) =>
                        void resolveApproval(approvalItem, "approved", response)
                      }
                      onReject={(approvalItem) =>
                        void resolveApproval(approvalItem, "rejected")
                      }
                      request={questionRequest}
                    />
                  );
                }

                return (
                  <div className="approval-row" key={approval.approvalId}>
                    <span className="approval-copy">
                      <strong>{approval.toolName}</strong>
                      <span>{approval.reason}</span>
                      {approvalDetailLines(approval.request).map((line) => (
                        <small key={line}>{line}</small>
                      ))}
                    </span>
                    <span className="approval-actions">
                      <button
                        aria-label={`批准 ${approval.toolName}`}
                        className="approval-action approve"
                        disabled={approval.state === "submitting"}
                        onClick={() => void resolveApproval(approval, "approved")}
                        title="批准"
                        type="button"
                      >
                        <Check size={16} />
                      </button>
                      <button
                        aria-label={`拒绝 ${approval.toolName}`}
                        className="approval-action reject"
                        disabled={approval.state === "submitting"}
                        onClick={() => void resolveApproval(approval, "rejected")}
                        title="拒绝"
                        type="button"
                      >
                        <X size={16} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </section>
          )}

          <form className="composer" onSubmit={submit}>
            <button className="icon-button" type="button" aria-label="添加附件">
              <Paperclip size={19} />
            </button>
            <textarea
              aria-label="消息"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onWheel={(event) => {
                if (event.currentTarget.scrollHeight > event.currentTarget.clientHeight) {
                  event.stopPropagation();
                }
              }}
              placeholder="有问题，尽管问"
              ref={inputRef}
              rows={1}
              value={input}
            />
            <button className="mode-button" type="button">
              DeepSeek
            </button>
            <button className="icon-button" type="button" aria-label="语音输入">
              <Mic size={18} />
            </button>
            {isStreaming ? (
              <button
                aria-label="停止"
                className="send-button"
                onClick={() => void stopStreaming()}
                type="button"
              >
                <CircleStop size={19} />
              </button>
            ) : (
              <button className="send-button" type="submit" aria-label="发送">
                <Send size={18} />
              </button>
            )}
          </form>
        </div>
      </section>

      <aside className="console-rail">{consolePanel}</aside>
    </main>
  );
}
