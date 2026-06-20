import { askUserQuestionTool } from "@/agent/tools/AskUserQuestionTool";
import { delegateTaskTool } from "@/agent/tools/DelegateTaskTool";
import { createFileTools } from "@/agent/tools/FileTools";
import { memoryTool } from "@/agent/tools/MemoryTool";
import { sessionSearchTool } from "@/agent/tools/SessionSearchTool";
import { createSkillTools } from "@/agent/tools/SkillTools";
import { createTaskTools } from "@/agent/tools/TaskTools";
import { createWebTools } from "@/agent/tools/WebTools";
import {
  parseToolArguments,
  truncateToolResult,
  type AgentTool,
  type ToolExecutionContext,
  toolError,
} from "@/agent/tools/types";
import type { ModelToolCall, ModelToolDefinition } from "@/agent/runtime/types";
import type { ToolUiManifest } from "@/shared/agent-protocol";

export function createDefaultTools(): AgentTool[] {
  return [
    memoryTool,
    sessionSearchTool,
    askUserQuestionTool,
    ...createTaskTools(),
    delegateTaskTool,
    ...createWebTools(),
    ...createFileTools(),
    ...createSkillTools(),
  ];
}

const SUBAGENT_BLOCKED_TOOLS = new Set([
  "activate_skill_install",
  "ask_user_question",
  "delegate_task",
  "edit_file",
  "install_github_skill",
  "manage_skill",
  "memory",
  "skill_manage",
  "task_cancel",
  "task_create",
  "task_list",
  "task_output",
  "task_update",
  "write_file",
  "write_file_chunk",
]);

function toolGroup(name: string): string | null {
  if (name === "web_search" || name === "web_extract") {
    return "web";
  }
  if (name === "read_file") {
    return "file";
  }
  if (name === "session_search") {
    return "session";
  }
  if (name === "skills_list" || name === "skill_view" || name === "list_installed_skills") {
    return "skills";
  }
  return null;
}

export function createSubagentTools(toolsets: string[] = []): AgentTool[] {
  const requested = new Set(
    (toolsets.length > 0 ? toolsets : ["web", "file", "session", "skills"]).map((toolset) =>
      toolset.trim().toLowerCase(),
    ),
  );

  return createDefaultTools().filter((tool) => {
    if (SUBAGENT_BLOCKED_TOOLS.has(tool.name)) {
      return false;
    }
    if (tool.isReadOnly !== true || tool.requiresUserInteraction === true) {
      return false;
    }
    if (tool.requiresApproval === true || typeof tool.requiresApproval === "function") {
      return false;
    }
    const group = toolGroup(tool.name);
    return group ? requested.has(group) : false;
  });
}

function toolEnabled(tool: AgentTool): boolean {
  try {
    return tool.isEnabled ? tool.isEnabled() : true;
  } catch {
    return false;
  }
}

export class ToolRegistry {
  private readonly tools: Map<string, AgentTool>;

  constructor(tools: AgentTool[] = createDefaultTools()) {
    this.tools = new Map(tools.filter(toolEnabled).map((tool) => [tool.name, tool]));
  }

  get definitions(): ModelToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  get manifest(): ToolUiManifest[] {
    return [...this.tools.values()].map((tool) => {
      const isReadOnly = tool.isReadOnly === true;
      return {
        description: tool.definition.function.description,
        displayName: tool.name,
        isReadOnly,
        name: tool.name,
        requiresApproval:
          tool.requiresUserInteraction === true ||
          tool.requiresApproval === true ||
          typeof tool.requiresApproval === "function" ||
          !isReadOnly,
        risk: tool.risk ?? (isReadOnly ? "read" : "write"),
      };
    });
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  async prepare(
    toolCall: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<
    | {
        args: unknown;
        ok: true;
        tool: AgentTool;
        toolCall: ModelToolCall;
      }
    | {
        args?: unknown;
        message: string;
        ok: false;
        result: string;
        tool?: AgentTool;
        toolCall: ModelToolCall;
      }
  > {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      const message = `Unknown tool '${toolCall.name}'.`;
      return { message, ok: false, result: toolError(message), toolCall };
    }

    try {
      const args = parseToolArguments(toolCall.arguments);
      const validation = await tool.validateInput?.(args, context, toolCall);
      if (validation && !validation.ok) {
        return {
          args,
          message: validation.message,
          ok: false,
          result: toolError(validation.message, validation.extra),
          tool,
          toolCall,
        };
      }
      return { args, ok: true, tool, toolCall };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      return { message, ok: false, result: toolError(message), tool, toolCall };
    }
  }

  async executePrepared(
    prepared: {
      args: unknown;
      tool: AgentTool;
      toolCall: ModelToolCall;
    },
    context: ToolExecutionContext,
  ): Promise<string> {
    try {
      return truncateToolResult(
        await prepared.tool.execute(prepared.args, context, prepared.toolCall),
        prepared.tool.maxResultSizeChars,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      return toolError(message);
    }
  }

  async execute(toolCall: ModelToolCall, context: ToolExecutionContext): Promise<string> {
    const prepared = await this.prepare(toolCall, context);
    if (!prepared.ok) {
      return prepared.result;
    }
    return this.executePrepared(prepared, context);
  }
}
