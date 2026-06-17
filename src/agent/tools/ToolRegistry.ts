import { memoryTool } from "@/agent/tools/MemoryTool";
import { sessionSearchTool } from "@/agent/tools/SessionSearchTool";
import {
  parseToolArguments,
  type AgentTool,
  type ToolExecutionContext,
  toolError,
} from "@/agent/tools/types";
import type { ModelToolCall, ModelToolDefinition } from "@/agent/runtime/types";

export class ToolRegistry {
  private readonly tools: Map<string, AgentTool>;

  constructor(tools: AgentTool[] = [memoryTool, sessionSearchTool]) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
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
      return await tool.execute(args, context, toolCall);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed";
      return toolError(message);
    }
  }
}
