"use client";

import {
  Bot,
  CircleStop,
  Library,
  Mic,
  MoreHorizontal,
  Paperclip,
  PanelsLeftBottom,
  Plus,
  Search,
  Send,
  User,
} from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
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

function parseSseEvent(eventText: string): AgentEvent | null {
  const dataLine = eventText
    .split("\n")
    .find((line) => line.startsWith("data: "));

  if (!dataLine) {
    return null;
  }

  return JSON.parse(dataLine.slice(6)) as AgentEvent;
}

export function ChatWorkspace() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState("准备就绪");
  const [lastError, setLastError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionLabel = useMemo(
    () => (sessionId ? `当前会话 ${sessionId.slice(0, 13)}` : "尚未创建会话"),
    [sessionId],
  );

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
    };

    setInput("");
    setLastError(null);
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setIsStreaming(true);
    setRunStatus("创建 run");

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch("/api/agent/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          maxTokens: 1024,
          message: prompt,
          sessionId,
        }),
        signal: abortController.signal,
      });

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
            setRunStatus("run 已接受");
          }

          if (event.type === "run.started") {
            setRunStatus("模型生成中");
          }

          if (event.type === "context.built") {
            setRunStatus(`上下文已构建 · 约 ${event.tokenEstimate} tokens`);
          }

          if (event.type === "assistant.delta") {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessage.id
                  ? { ...message, content: message.content + event.text }
                  : message,
              ),
            );
          }

          if (event.type === "run.completed") {
            setRunStatus("已完成");
          }

          if (event.type === "run.failed") {
            setLastError(event.error);
            setRunStatus("失败");
          }

          if (event.type === "run.aborted") {
            setRunStatus("已停止");
          }
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        setLastError(error instanceof Error ? error.message : "请求失败");
        setRunStatus("失败");
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
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

        <div className="account-row">
          <span className="avatar">AI</span>
          <span>
            <strong>本地开发</strong>
            <small>DeepSeek</small>
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
                <span className="message-avatar">
                  {message.role === "user" ?
                    <User size={16} />
                  : <Bot size={16} />}
                </span>
                <div className="message-content">{message.content || " "}</div>
              </article>
            ))
          )}
        </div>

        <div className="run-status" role="status">
          <span>{runStatus}</span>
          {lastError ? <strong>{lastError}</strong> : null}
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
