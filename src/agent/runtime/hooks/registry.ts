import type {
  HookContexts,
  HookEvent,
  HookHandler,
  PostModelResponseResult,
  PreModelCallRunResult,
  PreToolUseResult,
} from "@/agent/runtime/hooks/types";

type HookEntry<E extends HookEvent> = {
  handler: HookHandler<E>;
  name: string;
};

type RegistryBuckets = {
  [E in HookEvent]: Array<HookEntry<E>>;
};

function emptyBuckets(): RegistryBuckets {
  return {
    message_end: [],
    post_compact: [],
    post_model_response: [],
    post_tool_use: [],
    pre_compact: [],
    pre_model_call: [],
    pre_tool_use: [],
  };
}

export class AgentHookRegistry {
  private readonly buckets = emptyBuckets();

  register<E extends HookEvent>(
    event: E,
    name: string,
    handler: HookHandler<E>,
  ): void {
    this.buckets[event].push({ handler, name } as HookEntry<E>);
  }

  list(event: HookEvent): string[] {
    return this.buckets[event].map((entry) => entry.name);
  }

  async runPreModelCall(
    context: HookContexts["pre_model_call"],
  ): Promise<PreModelCallRunResult> {
    const reminders: string[] = [];
    let lastUserContentRewritten = false;

    for (const entry of this.buckets.pre_model_call) {
      try {
        const result = await entry.handler(context);
        if (result?.rewriteLastUserContent !== undefined && context.lastUserMessage) {
          context.lastUserMessage.content = result.rewriteLastUserContent;
          lastUserContentRewritten = true;
        }
        if (result?.reminders) {
          reminders.push(...result.reminders.filter((reminder) => reminder.trim().length > 0));
        }
      } catch (error) {
        console.error("Agent pre_model_call hook failed", { error, hook: entry.name });
      }
    }

    return { lastUserContentRewritten, reminders };
  }

  async runPostModelResponse(
    context: HookContexts["post_model_response"],
  ): Promise<PostModelResponseResult> {
    for (const entry of this.buckets.post_model_response) {
      try {
        const result = await entry.handler(context);
        if (result?.deny) {
          return result;
        }
      } catch (error) {
        console.error("Agent post_model_response hook failed", { error, hook: entry.name });
      }
    }

    return {};
  }

  async runPreToolUse(context: HookContexts["pre_tool_use"]): Promise<PreToolUseResult> {
    for (const entry of this.buckets.pre_tool_use) {
      try {
        const result = await entry.handler(context);
        if (result?.deny) {
          return { deny: result.deny };
        }
        if (result?.rewrite !== undefined) {
          context.input = result.rewrite;
        }
      } catch (error) {
        console.error("Agent pre_tool_use hook failed", { error, hook: entry.name });
      }
    }

    return { rewrite: context.input };
  }

  async runPostToolUse(context: HookContexts["post_tool_use"]): Promise<void> {
    await this.runObservational("post_tool_use", context);
  }

  async runPreCompact(context: HookContexts["pre_compact"]): Promise<void> {
    await this.runObservational("pre_compact", context);
  }

  async runPostCompact(context: HookContexts["post_compact"]): Promise<void> {
    await this.runObservational("post_compact", context);
  }

  async runMessageEnd(context: HookContexts["message_end"]): Promise<void> {
    await this.runObservational("message_end", context);
  }

  private async runObservational<E extends HookEvent>(
    event: E,
    context: HookContexts[E],
  ): Promise<void> {
    for (const entry of this.buckets[event]) {
      try {
        await (entry.handler as HookHandler<E>)(context);
      } catch (error) {
        console.error("Agent hook failed", { error, event, hook: entry.name });
      }
    }
  }
}
