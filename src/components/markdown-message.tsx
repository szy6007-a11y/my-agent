"use client";

import { code as streamdownCode } from "@streamdown/code";
import { Streamdown } from "streamdown";

export function MarkdownMessage({
  content,
  isStreaming = false,
}: {
  content: string;
  isStreaming?: boolean;
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
