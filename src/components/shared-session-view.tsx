"use client";

import { useEffect, useMemo, useState } from "react";
import type { SharedAgentSession } from "@/shared/agent-protocol";
import { MarkdownMessage } from "@/components/markdown-message";

type Status = "loading" | "ready" | "error";

function formatSharedDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function SharedSessionView({ token }: { token: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [share, setShare] = useState<SharedAgentSession | null>(null);
  const visibleMessages = useMemo(
    () => share?.messages.filter((message) => message.role === "user" || message.role === "assistant") ?? [],
    [share],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadShare() {
      try {
        const response = await fetch(`/api/agent/shared/${encodeURIComponent(token)}`);

        if (!response.ok) {
          throw new Error(String(response.status));
        }

        const body = (await response.json()) as { share?: SharedAgentSession };
        if (!body.share) {
          throw new Error("empty share");
        }

        if (!cancelled) {
          setShare(body.share);
          setStatus("ready");
        }
      } catch {
        if (!cancelled) {
          setStatus("error");
        }
      }
    }

    void loadShare();

    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === "loading") {
    return (
      <main className="shared-shell">
        <div className="shared-state">
          <strong>正在加载分享</strong>
        </div>
      </main>
    );
  }

  if (status === "error" || !share) {
    return (
      <main className="shared-shell">
        <div className="shared-state">
          <strong>分享链接不可用</strong>
          <span>这条链接不存在，或已被取消。</span>
        </div>
      </main>
    );
  }

  return (
    <main className="shared-shell">
      <header className="shared-header">
        <div>
          <strong>My Agent</strong>
          <span>分享的会话</span>
        </div>
        <time dateTime={share.createdAt}>{formatSharedDate(share.createdAt)}</time>
      </header>
      <section className="shared-title">
        <h1>{share.session.title}</h1>
        <span>{share.session.messageCount} 条消息</span>
      </section>
      <section className="shared-messages" aria-label="分享的消息">
        {visibleMessages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <div className="message-body">
              <div className="message-content">
                {message.role === "assistant" ?
                  <MarkdownMessage content={message.content} />
                : message.content || " "}
              </div>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
