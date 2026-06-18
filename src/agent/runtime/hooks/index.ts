export { registerBuiltinHooks } from "@/agent/runtime/hooks/builtin";
export { AgentHookRegistry } from "@/agent/runtime/hooks/registry";
export type {
  CompactContext,
  HookContexts,
  HookEvent,
  HookHandler,
  HookResults,
  MessageEndContext,
  PostModelResponseContext,
  PostModelResponseResult,
  PostToolUseContext,
  PreModelCallContext,
  PreModelCallResult,
  PreModelCallRunResult,
  PreToolUseContext,
  PreToolUseResult,
} from "@/agent/runtime/hooks/types";

import { registerBuiltinHooks } from "@/agent/runtime/hooks/builtin";
import { AgentHookRegistry } from "@/agent/runtime/hooks/registry";

export function createDefaultHookRegistry(): AgentHookRegistry {
  const registry = new AgentHookRegistry();
  registerBuiltinHooks(registry);
  return registry;
}
