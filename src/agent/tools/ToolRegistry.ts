import { memoryTool } from "@/agent/tools/MemoryTool";
import { sessionSearchTool } from "@/agent/tools/SessionSearchTool";
import { createWebTools } from "@/agent/tools/WebTools";
import {
  parseToolArguments,
  truncateToolResult,
  type AgentTool,
  type ToolExecutionContext,
  toolError,
} from "@/agent/tools/types";
import type { ModelToolCall, ModelToolDefinition } from "@/agent/runtime/types";

function defaultTools(): AgentTool[] {
  return [memoryTool, sessionSearchTool, ...createWebTools()];
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

  constructor(tools: AgentTool[] = defaultTools()) {
    this.tools = new Map(tools.filter(toolEnabled).map((tool) => [tool.name, tool]));
  }

  get definitions(): ModelToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  async execute(toolCall: ModelToolCall, context: ToolExecutionContext): Promise<string> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return toolError(`Unknown tool '${toolCall.name}'.`);
    }

    try {
      const args = parseToolArguments(toolCall.arguments);
      return truncateToolResult(await tool.execute(args, context, toolCall), tool.maxResultSizeChars);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      return toolError(message);
    }
  }
}
