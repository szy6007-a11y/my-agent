export const VISIBLE_TOOL_CALL_VIOLATION_REASON = "visible_tool_call" as const;

export type VisibleToolCallViolation = {
  reason: typeof VISIBLE_TOOL_CALL_VIOLATION_REASON;
  toolName: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstCapture(match: RegExpExecArray | null): string | null {
  if (!match) {
    return null;
  }

  for (let index = 1; index < match.length; index += 1) {
    const value = match[index];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

export class VisibleToolCallDetector {
  private readonly genericPatterns: RegExp[];
  private readonly maxBufferChars: number;
  private readonly structuredToolPatterns: RegExp[];
  private buffer = "";

  constructor(toolNames: readonly string[], maxBufferChars = 512) {
    const names = [...new Set(toolNames)].filter(Boolean);
    this.maxBufferChars = maxBufferChars;
    const alternatives = names.map(escapeRegExp).join("|");
    this.structuredToolPatterns =
      names.length > 0 ?
        [
          new RegExp(`(?:^|[^A-Za-z0-9_.$-])(${alternatives})\\s*\\(`),
          new RegExp(`<\\s*/?\\s*(${alternatives})(?=[\\s>/])`, "i"),
        ]
      : [];
    this.genericPatterns = [
      /<[^>\n]*\binvoke\s+name=["']([^"']+)["'][^>]*>/i,
      /["']tool_type["']\s*:\s*["']([^"']+)["']/i,
      /<\s*tool_name\s*>\s*([^<]+?)\s*<\s*\/\s*tool_name\s*>/i,
      /<\s*parameter\s+name=["'][^"']+["'][^>]*>/i,
    ];
  }

  push(chunk: string): VisibleToolCallViolation | null {
    if (!chunk) {
      return null;
    }

    this.buffer += chunk;

    for (const pattern of this.structuredToolPatterns) {
      const toolName = firstCapture(pattern.exec(this.buffer));
      if (toolName) {
        return {
          reason: VISIBLE_TOOL_CALL_VIOLATION_REASON,
          toolName,
        };
      }
    }

    for (const pattern of this.genericPatterns) {
      const toolName = firstCapture(pattern.exec(this.buffer)) ?? "unknown";
      if (toolName !== "unknown" || pattern.test(this.buffer)) {
        return {
          reason: VISIBLE_TOOL_CALL_VIOLATION_REASON,
          toolName,
        };
      }
    }

    if (this.buffer.length > this.maxBufferChars) {
      this.buffer = this.buffer.slice(-this.maxBufferChars);
    }

    return null;
  }
}
