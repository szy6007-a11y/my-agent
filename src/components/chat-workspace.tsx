"use client";

import {
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
import { FormEvent, useMemo, useRef, useState } from "react";

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
          }

          if (event.type === "assistant.delta") {
            setMessages((current) =>
              appendMessageContent(current, assistantMessage.id, event.text),
            );
          }

          if (event.type === "run.completed") {
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
