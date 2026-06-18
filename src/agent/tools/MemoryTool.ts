import { MemoryStore, type MemoryTarget } from "@/agent/memory/MemoryStore";
import type { AgentTool } from "@/agent/tools/types";
import { toolError } from "@/agent/tools/types";

type MemoryToolArgs = {
  action?: "add" | "replace" | "remove";
  content?: string;
  old_text?: string;
  target?: MemoryTarget;
};

function asMemoryArgs(args: unknown): MemoryToolArgs {
  return args && typeof args === "object" ? (args as MemoryToolArgs) : {};
}

export const memoryTool: AgentTool = {
  name: "memory",
  definition: {
    type: "function",
    function: {
      name: "memory",
      description:
        "Save durable information to persistent MEMORY.md or USER.md. Use for stable user preferences, corrections, environment facts, project conventions, and tool quirks that will still matter later. Do NOT save task progress, session outcomes, PR/issue numbers, commit SHAs, temporary TODOs, or completed-work logs; use session_search for those. Write entries as declarative facts, not instructions.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "replace", "remove"],
            description: "Mutation to perform.",
          },
          target: {
            type: "string",
            enum: ["memory", "user"],
            description:
              "'user' is the human profile; 'memory' is agent notes about environment, projects, conventions, and tool quirks.",
          },
          content: {
            type: "string",
            description: "Entry content. Required for add and replace.",
          },
          old_text: {
            type: "string",
            description: "Short unique substring identifying the entry to replace or remove.",
          },
        },
        required: ["action", "target"],
      },
    },
  },
  isReadOnly: false,
  requiresApproval: true,
  risk: "write",
  async execute(args, context) {
    const input = asMemoryArgs(args);
    const target = input.target ?? "memory";

    if (target !== "memory" && target !== "user") {
      return toolError(`Invalid target '${String(target)}'. Use 'memory' or 'user'.`);
    }

    const store = new MemoryStore(context.userId);
    store.loadFromDisk();

    if (input.action === "add") {
      if (!input.content) {
        return toolError("content is required for add.");
      }
      return JSON.stringify(await store.add(target, input.content));
    }

    if (input.action === "replace") {
      if (!input.old_text || !input.content) {
        return toolError("old_text and content are required for replace.");
      }
      return JSON.stringify(await store.replace(target, input.old_text, input.content));
    }

    if (input.action === "remove") {
      if (!input.old_text) {
        return toolError("old_text is required for remove.");
      }
      return JSON.stringify(await store.remove(target, input.old_text));
    }

    return toolError("Unknown action. Use add, replace, or remove.");
  },
};
