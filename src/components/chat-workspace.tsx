"use client";

import {
  Activity,
  Check,
  ChevronDown,
  CircleStop,
  Copy,
  LogOut,
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
import { code as streamdownCode } from "@streamdown/code";
import { Streamdown } from "streamdown";

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

type AgentEvent =
  | { type: "run.accepted"; runId: string; sessionId: string }
  | { type: "run.started"; runId: string }
  | { type: "context.built"; snapshotId: string; tokenEstimate: number }
  | { type: "assistant.delta"; messageId: string; text: string }
  | { type: "reasoning.delta"; messageId: string; text: string }
  | { type: "tool.started"; runId: string; toolCallId: string; toolName: string }
  | { type: "tool.completed"; runId: string; toolCallId: string; toolName: string }
  | { type: "tool.failed"; runId: string; toolCallId: string; toolName: string; error: string }
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
  const abortControllerRef = useRef<AbortController | null>(null);
  const autoScrollRef = useRef(true);
  const isAtBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const userDetachedFromBottomRef = useRef(false);
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
    setMonitorConnection("connecting");
    setServiceSnapshot(null);
    autoScrollRef.current = true;
    isAtBottomRef.current = true;
    lastScrollTopRef.current = 0;
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
    userDetachedFromBottomRef.current = false;
    setMessages([]);
    setSessionId(null);
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
        messages: Array<{
          content: string;
          id: string;
          role: "user" | "assistant";
        }>;
      };

      setSessionId(nextSessionId);
      autoScrollRef.current = true;
      isAtBottomRef.current = true;
      lastScrollTopRef.current = 0;
      userDetachedFromBottomRef.current = false;
      setMessages(
        body.messages.map((message) => ({
          content: message.content,
          id: message.id,
          role: message.role,
          status: "complete",
        })),
      );
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
            void refreshSessions();
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

          if (event.type === "tool.started") {
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "tool",
              message: `工具开始 ${event.toolName}`,
            });
          }

          if (event.type === "tool.completed") {
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "info",
              source: "tool",
              message: `工具完成 ${event.toolName}`,
            });
          }

          if (event.type === "tool.failed") {
            appendConsoleLog({
              at: new Date().toISOString(),
              level: "warn",
              source: "tool",
              message: `工具失败 ${event.toolName}：${event.error}`,
            });
          }

          if (event.type === "run.completed") {
            void refreshSessions();
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
