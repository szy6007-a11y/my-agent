"use client";

import {
  Activity,
  Check,
  CircleStop,
  Copy,
  Library,
  Mic,
  MoreHorizontal,
  Paperclip,
  PanelsLeftBottom,
  Plus,
  Search,
  Send,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ServiceHealthSnapshot,
  ServiceHealthState,
  ServiceHealthStatus,
} from "@/lib/service-health";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "streaming" | "complete" | "failed" | "aborted";
};

type AgentEvent =
  | { type: "run.accepted"; runId: string; sessionId: string }
  | { type: "run.started"; runId: string }
  | { type: "context.built"; snapshotId: string; tokenEstimate: number }
  | { type: "assistant.delta"; messageId: string; text: string }
  | { type: "reasoning.delta"; messageId: string; text: string }
  | { type: "usage.updated"; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  | { type: "run.completed"; runId: string; finalMessageId: string }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.aborted"; runId: string; reason: string };

type MonitorConnection = "connecting" | "connected" | "disconnected";

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

function formatConsoleTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
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

function logLevelLabel(level: ServiceConsoleLog["level"]) {
  if (level === "error") return "错误";
  if (level === "warn") return "警告";
  return "信息";
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

function updateMessage(
  messages: ChatMessage[],
  messageId: string,
  updates: Partial<ChatMessage>,
) {
  return messages.map((message) =>
    message.id === messageId ? { ...message, ...updates } : message,
  );
}

export function ChatWorkspace() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [monitorConnection, setMonitorConnection] =
    useState<MonitorConnection>("connecting");
  const [serviceSnapshot, setServiceSnapshot] =
    useState<ServiceHealthSnapshot | null>(null);
  const [consoleLogs, setConsoleLogs] = useState<ServiceConsoleLog[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionLabel = useMemo(
    () => (sessionId ? `当前会话 ${sessionId.slice(0, 13)}` : "尚未创建会话"),
    [sessionId],
  );
  const checkedAtLabel = serviceSnapshot ?
    `最近检查 ${formatConsoleTime(serviceSnapshot.checkedAt)}`
  : "等待第一条快照";
  const overallStatusLabel = serviceSnapshot ?
    healthStatusLabel(serviceSnapshot.status)
  : "建立监听";

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

  useEffect(() => {
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
        id: `status-${payload.sequence}`,
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
  }, [appendConsoleLog]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const prompt = input.trim();
    if (!prompt || isStreaming) {
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
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setIsStreaming(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch("/api/agent/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxTokens: 1024,
          message: prompt,
          ...(sessionId ? { sessionId } : {}),
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
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
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "agent",
              message: `运行已接收 ${shortRunId(event.runId)}`,
            });
          }

          if (event.type === "run.started") {
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

          if (event.type === "assistant.delta") {
            setMessages((current) =>
              appendMessageContent(current, assistantMessage.id, event.text),
            );
          }

          if (event.type === "run.completed") {
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
                    : "没有收到模型回复，请再试一次。",
                  status: "complete",
                },
              );
            });
          }

          if (event.type === "run.failed") {
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

  function stopStreaming() {
    abortControllerRef.current?.abort();
    setIsStreaming(false);
  }

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
          <button className="nav-item active">
            <Plus size={17} />
            新聊天
          </button>
          <button className="nav-item">
            <Search size={17} />
            搜索聊天
          </button>
          <button className="nav-item">
            <Library size={17} />
            库
          </button>
          <button className="nav-item">
            <MoreHorizontal size={17} />
            更多
          </button>
        </nav>

        <section className="chat-list">
          <p className="section-label">会话</p>
          <div className="sidebar-state">
            <strong>{sessionLabel}</strong>
            <span>{messages.length > 0 ? `${messages.length} 条消息` : "发送消息后开始"}</span>
          </div>
        </section>

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

        <div className="account-row">
          <span className="avatar">T</span>
          <span className="account-details">
            <strong>TEST</strong>
            <small>Pro</small>
          </span>
        </div>
      </aside>

      <section className="workspace">
        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">
              <h1>今天想做什么？</h1>
            </div>
          ) : (
            messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-body">
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
                  : <div className="message-content">{message.content || " "}</div>}
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
        </div>

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
            placeholder="有问题，尽管问"
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
            <button className="send-button" type="button" onClick={stopStreaming}>
              <CircleStop size={19} />
            </button>
          ) : (
            <button className="send-button" type="submit" aria-label="发送">
              <Send size={18} />
            </button>
          )}
        </form>
      </section>
    </main>
  );
}
