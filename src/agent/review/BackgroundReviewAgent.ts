import { ContextEngine } from "@/agent/context/ContextEngine";
import { ModelRouter } from "@/agent/models/ModelRouter";
import type { ModelMessage, ModelToolCall } from "@/agent/runtime/types";
import { sessionRepository, type SessionRepository } from "@/agent/sessions/SessionRepository";
import { memoryTool } from "@/agent/tools/MemoryTool";
import { ToolRegistry } from "@/agent/tools/ToolRegistry";
import { serverEnv } from "@/lib/env";

const REVIEW_MAX_TOOL_ROUNDS = 4;
const REVIEW_TRANSCRIPT_LIMIT = 60;

function renderTranscript(messages: Awaited<ReturnType<SessionRepository["listMessages"]>>): string {
  return messages
    .filter((message) => {
      if (message.role === "user") {
        return true;
      }
      return message.role === "assistant" && !message.toolCalls?.length && message.content.trim();
    })
    .slice(-REVIEW_TRANSCRIPT_LIMIT)
    .map((message) => `${message.role.toUpperCase()}: ${message.content.trim()}`)
    .join("\n\n");
}

function reviewPrompt(transcript: string): string {
  return `You are a background memory review agent for this chat system.

Review the transcript and decide whether durable facts should be written to memory.

Use the memory tool only when there is a stable, reusable fact that is likely to matter in future sessions:
- target "user" for the human's durable profile, preferences, name, language, and long-term constraints.
- target "memory" for durable project conventions, environment facts, repository quirks, and agent operating notes.

Do not save task progress, completed work, temporary plans, issue/PR numbers, commit hashes, transient debugging state, or one-off conversation summaries.
Do not save runtime/tool availability facts, tool outputs, or assistant self-descriptions unless the user explicitly provided or corrected that durable fact.
Do not invent facts. Do not write facts already present in memory. Prefer concise declarative entries.
Use replace/remove only when the transcript clearly corrects stale memory.
If nothing should be saved, do not call any tool and return a short no-op response.

Transcript:
${transcript}`;
}

export class BackgroundReviewAgent {
  constructor(
    private readonly modelRouter = new ModelRouter(),
    private readonly sessions: SessionRepository = sessionRepository,
    private readonly contextEngine = new ContextEngine(),
  ) {}

  async maybeRun(input: {
    model: string;
    runId: string;
    sessionId: string;
    thinking: "enabled" | "disabled";
    userId: string;
  }): Promise<void> {
    const interval = serverEnv.MEMORY_REVIEW_INTERVAL;
    if (interval <= 0) {
      return;
    }

    const messages = await this.sessions.listMessages(input.sessionId, {
      limit: 120,
      userId: input.userId,
    });
    const userTurns = messages.filter((message) => message.role === "user").length;
    if (userTurns === 0 || userTurns % interval !== 0) {
      return;
    }

    const transcript = renderTranscript(messages);
    if (!transcript.trim()) {
      return;
    }

    const tools = new ToolRegistry([memoryTool]);
    const baseContext = this.contextEngine.build({
      availableTools: tools.names,
      messages: [],
      model: input.model,
      provider: "deepseek",
      sessionId: input.sessionId,
      userId: input.userId,
    });
    const workingMessages: ModelMessage[] = [
      ...baseContext.messages,
      {
        role: "user",
        content: reviewPrompt(transcript),
      },
    ];
    const signal = new AbortController().signal;

    for (let round = 0; round < REVIEW_MAX_TOOL_ROUNDS; round += 1) {
      let assistantText = "";
      const toolCalls: ModelToolCall[] = [];

      for await (const event of this.modelRouter.stream({
        context: {
          ...baseContext,
          messages: workingMessages,
        },
        maxTokens: 768,
        model: input.model,
        runId: `${input.runId}_memory_review`,
        sessionId: input.sessionId,
        signal,
        thinking: input.thinking,
        tools: tools.definitions,
        userId: input.userId,
      })) {
        if (event.type === "text_delta") {
          assistantText += event.text;
        }
        if (event.type === "tool_calls") {
          toolCalls.push(...event.toolCalls);
        }
      }

      if (toolCalls.length === 0) {
        return;
      }

      workingMessages.push({
        role: "assistant",
        content: assistantText.trim() ? assistantText : null,
        toolCalls,
      });

      for (const toolCall of toolCalls) {
        const result = await tools.execute(toolCall, {
          runId: `${input.runId}_memory_review`,
          sessionId: input.sessionId,
          sessions: this.sessions,
          userId: input.userId,
        });

        workingMessages.push({
          role: "tool",
          content: result,
          toolCallId: toolCall.id,
        });
      }
    }
  }
}
