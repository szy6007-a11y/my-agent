import { ContextEngine } from "@/agent/context/ContextEngine";
import { ModelRouter } from "@/agent/models/ModelRouter";
import type { ModelMessage, ModelToolCall } from "@/agent/runtime/types";
import { sessionRepository, type SessionRepository } from "@/agent/sessions/SessionRepository";
import { memoryTool } from "@/agent/tools/MemoryTool";
import { createSkillTools } from "@/agent/tools/SkillTools";
import { ToolRegistry } from "@/agent/tools/ToolRegistry";
import type { AgentTool } from "@/agent/tools/types";
import { serverEnv } from "@/lib/env";

const REVIEW_MAX_TOOL_ROUNDS = 16;
const REVIEW_TRANSCRIPT_LIMIT = 80;
const MESSAGE_CONTENT_CHAR_LIMIT = 2_000;
const TOOL_ARGUMENT_CHAR_LIMIT = 700;
const TOOL_RESULT_CHAR_LIMIT = 1_200;
const SELF_IMPROVEMENT_SKILL_TOOLS = new Set([
  "Skill",
  "list_installed_skills",
  "skill_manage",
  "skill_view",
  "skills_list",
]);

function renderTranscript(messages: Awaited<ReturnType<SessionRepository["listMessages"]>>): string {
  return messages
    .filter((message) => {
      if (message.role === "user") {
        return true;
      }
      return (
        message.role === "assistant" ||
        message.role === "tool"
      ) && (message.content.trim() || message.toolCalls?.length);
    })
    .slice(-REVIEW_TRANSCRIPT_LIMIT)
    .map((message) => {
      const role = message.role.toUpperCase();
      if (message.role === "assistant" && message.toolCalls?.length) {
        const calls = message.toolCalls
          .map(
            (toolCall) =>
              `${toolCall.name}(${truncate(toolCall.arguments, TOOL_ARGUMENT_CHAR_LIMIT)})`,
          )
          .join("\n");
        const text = message.content.trim() ? `\n${truncate(message.content, MESSAGE_CONTENT_CHAR_LIMIT)}` : "";
        return `${role}_TOOL_CALLS:\n${calls}${text}`;
      }
      if (message.role === "tool") {
        const toolName = message.toolName ? ` ${message.toolName}` : "";
        return `${role}${toolName}:\n${truncate(message.content, TOOL_RESULT_CHAR_LIMIT)}`;
      }
      return `${role}:\n${truncate(message.content, MESSAGE_CONTENT_CHAR_LIMIT)}`;
    })
    .join("\n\n");
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.floor(maxChars * 0.2);
  return `${normalized.slice(0, headChars)}

[...middle omitted for background review...]

${normalized.slice(-tailChars)}`;
}

export type BackgroundReviewTargets = {
  memory: boolean;
  skills: boolean;
};

export function selectBackgroundReviewTargets(input: {
  memoryInterval: number;
  skillInterval: number;
  toolIterationsThisRun: number;
  totalToolIterations: number;
  userTurns: number;
}): BackgroundReviewTargets {
  const memory =
    input.memoryInterval > 0 &&
    input.userTurns > 0 &&
    input.userTurns % input.memoryInterval === 0;
  const previousToolIterations = Math.max(
    0,
    input.totalToolIterations - Math.max(0, input.toolIterationsThisRun),
  );
  const skills =
    input.skillInterval > 0 &&
    input.toolIterationsThisRun > 0 &&
    Math.floor(previousToolIterations / input.skillInterval) <
      Math.floor(input.totalToolIterations / input.skillInterval);

  return { memory, skills };
}

function countToolIterations(messages: Awaited<ReturnType<SessionRepository["listMessages"]>>): number {
  return messages.filter(
    (message) => message.role === "assistant" && Boolean(message.toolCalls?.length),
  ).length;
}

function reviewPrompt(transcript: string, targets: BackgroundReviewTargets): string {
  if (targets.memory && targets.skills) {
    return combinedReviewPrompt(transcript);
  }
  if (targets.skills) {
    return skillReviewPrompt(transcript);
  }
  return memoryReviewPrompt(transcript);
}

function memoryReviewPrompt(transcript: string): string {
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

function skillReviewPrompt(transcript: string): string {
  return `You are a background skill review agent for this chat system.

Review the transcript and update the user's procedural skill library when the session produced durable know-how.

Use skills_list and skill_view to inspect existing skills before writing. Prefer updating the most relevant existing class-level skill over creating a narrow one-off skill.

Signals that warrant a skill update:
- The user corrected style, tone, workflow, sequencing, verification, or tool-use behavior.
- A non-trivial debugging path, implementation technique, workaround, checklist, or repeatable process emerged.
- A loaded skill was incomplete, stale, wrong, or missing a pitfall.

Use skill_manage only for durable procedural knowledge:
- action "patch" for small exact edits.
- action "edit" for full SKILL.md rewrites after skill_view.
- action "write_file" for support files under references/, templates/, scripts/, or assets/.
- action "create" only for a broad class-level reusable skill when no existing skill fits.

Do not save task progress, one-off narratives, issue/PR numbers, commit hashes, transient setup failures, missing local binaries, temporary credentials, or "tool X is broken" claims. Capture the reusable fix or workflow instead.
Do not delete or remove skills in this background review. If nothing durable should change, do not call any tool and return "Nothing to save."

Transcript:
${transcript}`;
}

function combinedReviewPrompt(transcript: string): string {
  return `You are a background self-improvement review agent for this chat system.

Review the transcript and update two durable stores when appropriate:

Memory:
- Use memory target "user" for stable user profile, preferences, language, and long-term constraints.
- Use memory target "memory" for durable project conventions, environment facts, repository quirks, and agent operating notes.

Skills:
- Use skills_list and skill_view to inspect existing skills before writing.
- Use skill_manage action "patch", "edit", "write_file", or "create" for reusable procedural knowledge.
- Prefer updating an existing class-level skill. Create only when no suitable skill exists.

Do not save task progress, completed-work logs, issue/PR numbers, commit hashes, transient debugging state, missing local setup, temporary credentials, or one-off conversation summaries.
Do not delete or remove skills in this background review.
If nothing should be saved, do not call any tool and return "Nothing to save."

Transcript:
${transcript}`;
}

function toolsForReview(targets: BackgroundReviewTargets): AgentTool[] {
  const tools: AgentTool[] = [];
  if (targets.memory) {
    tools.push(memoryTool);
  }
  if (targets.skills) {
    tools.push(...createSkillTools().filter((tool) => SELF_IMPROVEMENT_SKILL_TOOLS.has(tool.name)));
  }
  return tools;
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
    toolIterations?: number;
    userId: string;
  }): Promise<void> {
    const memoryInterval = serverEnv.MEMORY_REVIEW_INTERVAL;
    const skillInterval = serverEnv.SKILL_REVIEW_INTERVAL;
    if (memoryInterval <= 0 && skillInterval <= 0) {
      return;
    }

    const messages = await this.sessions.listMessages(input.sessionId, {
      limit: 120,
      userId: input.userId,
    });
    const userTurns = messages.filter((message) => message.role === "user").length;
    const totalToolIterations = countToolIterations(messages);
    const targets = selectBackgroundReviewTargets({
      memoryInterval,
      skillInterval,
      toolIterationsThisRun: input.toolIterations ?? 0,
      totalToolIterations,
      userTurns,
    });
    if (!targets.memory && !targets.skills) {
      return;
    }

    const transcript = renderTranscript(messages);
    if (!transcript.trim()) {
      return;
    }

    const tools = new ToolRegistry(toolsForReview(targets));
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
        content: reviewPrompt(transcript, targets),
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
        runId: `${input.runId}_self_improvement_review`,
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
          runId: `${input.runId}_self_improvement_review`,
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
