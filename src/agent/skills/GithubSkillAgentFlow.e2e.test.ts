import assert from "node:assert/strict";
import test from "node:test";

import type { ModelStreamInput } from "@/agent/models/ProviderAdapter";
import type { ModelToolCall } from "@/agent/runtime/types";

const RUN_E2E = process.env.RUN_GITHUB_SKILL_E2E === "true";
const SOURCE =
  "https://github.com/NousResearch/hermes-agent/tree/main/optional-skills/communication/one-three-one-rule";

function latestToolJson(input: ModelStreamInput): Record<string, unknown> | null {
  const lastTool = [...input.context.messages].reverse().find((message) => message.role === "tool");
  if (!lastTool || lastTool.role !== "tool") {
    return null;
  }
  try {
    return JSON.parse(lastTool.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toolCall(name: string, args: Record<string, unknown>, index: number): ModelToolCall {
  return {
    arguments: JSON.stringify(args),
    id: `call_${index}_${name}`,
    name,
  };
}

class GithubSkillFlowModelRouter {
  calls = 0;
  loadedSkillContent = "";

  async *stream(input: ModelStreamInput) {
    this.calls += 1;
    const last = latestToolJson(input);

    if (!last) {
      yield {
        type: "tool_calls" as const,
        toolCalls: [toolCall("install_github_skill", { source: SOURCE }, this.calls)],
      };
      return;
    }

    if (typeof last.proposal_id === "string") {
      yield {
        type: "tool_calls" as const,
        toolCalls: [
          toolCall("activate_skill_install", { proposal_id: last.proposal_id }, this.calls),
        ],
      };
      return;
    }

    if (last.status === "active" && last.skill && typeof last.skill === "object") {
      const skill = last.skill as { name?: unknown };
      yield {
        type: "tool_calls" as const,
        toolCalls: [
          toolCall(
            "Skill",
            {
              arguments: "请用该 skill 回答：如何向团队说明 GitHub Skill 安装链路？",
              skill_name: String(skill.name ?? "one-three-one-rule"),
            },
            this.calls,
          ),
        ],
      };
      return;
    }

    if (typeof last.content === "string") {
      this.loadedSkillContent = last.content;
      yield {
        type: "text_delta" as const,
        text:
          "1\nGitHub Skill 安装链路已经完成下载、启用和加载。\n\n3\n- 已从 GitHub 固定到 commit 并下载 Skill。\n- 已通过审批启用到当前用户 Skill 集。\n- 已加载 Skill 正文并按 1-3-1 结构组织回答。\n\n1\n验收结论：GITHUB_SKILL_E2E_APPLIED。",
      };
      return;
    }

    yield { type: "text_delta" as const, text: "GITHUB_SKILL_E2E_UNEXPECTED_STATE" };
  }
}

class NoopBackgroundReview {
  async maybeRun(): Promise<void> {
    return;
  }
}

test(
  "agent downloads, activates, loads, and applies a GitHub skill",
  { skip: RUN_E2E ? false : "set RUN_GITHUB_SKILL_E2E=true to run the network/database e2e" },
  async () => {
    process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";
    const [{ AgentLoop }, { RunController }, { sessionRepository }, { getSql }] = await Promise.all([
      import("@/agent/runtime/AgentLoop"),
      import("@/agent/runtime/RunController"),
      import("@/agent/sessions/SessionRepository"),
      import("@/lib/db"),
    ]);
    const modelRouter = new GithubSkillFlowModelRouter();
    const loop = new AgentLoop(
      undefined,
      modelRouter as never,
      sessionRepository,
      new NoopBackgroundReview() as never,
    );
    const controller = new RunController(sessionRepository, loop);
    const events = [];
    const userId = `usr_github_skill_e2e_${Date.now()}`;

    try {
      for await (const event of controller.startRun(
        {
          maxTokens: 1024,
          message:
            "下载 GitHub 上 NousResearch/hermes-agent 的 one-three-one-rule skill，安装后用它回答如何向团队说明 GitHub Skill 安装链路。",
          permissionMode: "ask-on-write",
        },
        new AbortController().signal,
        userId,
      )) {
        events.push(event);
        if (event.type === "tool.approval.required") {
          await sessionRepository.resolveToolApproval({
            approvalId: event.approvalId,
            decision: "approved",
            decisionReason: "automated e2e approval",
            userId,
          });
        }
      }
    } finally {
      await getSql().end({ timeout: 1 });
    }

    const completedTools = events
      .filter((event) => event.type === "tool.completed")
      .map((event) => event.toolName);

    assert.deepEqual(completedTools, [
      "install_github_skill",
      "activate_skill_install",
      "Skill",
    ]);
    assert.match(modelRouter.loadedSkillContent, /1-3-1|one-three-one|一三一/i);
    assert.ok(events.some((event) => event.type === "run.completed"));
    const finalText = events
      .filter((event) => event.type === "assistant.delta")
      .map((event) => event.text)
      .join("");
    assert.match(finalText, /GITHUB_SKILL_E2E_APPLIED/);
  },
);
