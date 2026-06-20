import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

test("PromptAssembler includes the production output protocol contract", async () => {
  const { PromptAssembler } = await import("@/agent/context/PromptAssembler");
  const assembly = new PromptAssembler().assemble({
    availableTools: ["write_file_chunk", "web_search"],
    model: "gpt-5",
    now: new Date("2026-06-19T00:00:00.000Z"),
    platform: "webui",
  });

  assert.equal(assembly.metadata?.promptVersion, "2026-06-20.web-grounding-v2");
  assert.match(assembly.prompt, /<output_protocol_guidance/);
  assert.match(assembly.prompt, /工具只能通过系统原生 tool call 通道调用/);
  assert.match(assembly.prompt, /禁止把工具调用写成 XML、HTML、Markdown、JSON、函数调用文本、DSML/);
  assert.match(assembly.prompt, /不要把“某站点被 block\/blocked”“工具受限”“我换个方向搜索”等检索过程写进最终正文/);
  assert.match(assembly.prompt, /如果 `SKILL\.md` 明确要求调用某个工具/);
  assert.match(assembly.prompt, /不要用普通正文回答、承诺、追问、列计划或复述工具名来替代/);
});

test("PromptAssembler injects Hermes OpenAI execution guidance for GPT-family models", async () => {
  const { PromptAssembler } = await import("@/agent/context/PromptAssembler");
  const assembly = new PromptAssembler().assemble({
    availableTools: ["write_file_chunk", "web_search"],
    model: "gpt-5",
    now: new Date("2026-06-19T00:00:00.000Z"),
    platform: "webui",
  });

  assert.match(assembly.prompt, /<hermes_task_completion_guidance/);
  assert.match(assembly.prompt, /When the user asks you to build, run, or verify something/);
  assert.match(assembly.prompt, /<hermes_tool_use_enforcement_guidance/);
  assert.match(assembly.prompt, /You MUST use your tools to take action/);
  assert.match(assembly.prompt, /<hermes_openai_model_execution_guidance/);
  assert.match(assembly.prompt, /<mandatory_tool_use>/);
  assert.match(assembly.prompt, /Current facts \(weather, news, versions\) → use web_search/);
});

test("PromptAssembler follows Hermes DeepSeek gate exactly", async () => {
  const { PromptAssembler } = await import("@/agent/context/PromptAssembler");
  const assembly = new PromptAssembler().assemble({
    availableTools: ["web_search"],
    model: "deepseek-v4-pro",
    now: new Date("2026-06-19T00:00:00.000Z"),
    platform: "webui",
  });

  assert.match(assembly.prompt, /<hermes_task_completion_guidance/);
  assert.match(assembly.prompt, /<hermes_tool_use_enforcement_guidance/);
  assert.doesNotMatch(assembly.prompt, /<hermes_openai_model_execution_guidance/);
  assert.doesNotMatch(
    assembly.prompt,
    /Current facts \(weather, news, versions\) → use web_search/,
  );
});

test("PromptAssembler omits Hermes tool guidance when no tools are available", async () => {
  const { PromptAssembler } = await import("@/agent/context/PromptAssembler");
  const assembly = new PromptAssembler().assemble({
    availableTools: [],
    model: "gpt-5",
    now: new Date("2026-06-19T00:00:00.000Z"),
    platform: "webui",
  });

  assert.doesNotMatch(assembly.prompt, /<hermes_task_completion_guidance/);
  assert.doesNotMatch(assembly.prompt, /<hermes_tool_use_enforcement_guidance/);
  assert.doesNotMatch(assembly.prompt, /<hermes_openai_model_execution_guidance/);
});

test("PromptAssembler injects ask_user_question guidance only when the tool is available", async () => {
  const { PromptAssembler } = await import("@/agent/context/PromptAssembler");
  const withQuestionTool = new PromptAssembler().assemble({
    availableTools: ["ask_user_question", "web_search"],
    model: "deepseek-v4-pro",
    now: new Date("2026-06-20T00:00:00.000Z"),
    platform: "webui",
  });
  const withoutQuestionTool = new PromptAssembler().assemble({
    availableTools: ["web_search"],
    model: "deepseek-v4-pro",
    now: new Date("2026-06-20T00:00:00.000Z"),
    platform: "webui",
  });

  assert.match(withQuestionTool.prompt, /<ask_user_question_guidance/);
  assert.match(withQuestionTool.prompt, /必须调用该工具；不要用普通正文追问/);
  assert.match(withQuestionTool.prompt, /用户界面会自动提供“其他”自由输入/);
  assert.doesNotMatch(withoutQuestionTool.prompt, /<ask_user_question_guidance/);
});

test("PromptAssembler names task and delegation tools in stable guidance", async () => {
  const { PromptAssembler } = await import("@/agent/context/PromptAssembler");
  const assembly = new PromptAssembler().assemble({
    availableTools: ["task_create", "task_update", "delegate_task", "web_search"],
    model: "deepseek-v4-pro",
    now: new Date("2026-06-20T00:00:00.000Z"),
    platform: "webui",
  });

  assert.match(assembly.prompt, /`task_create`、`task_update`、`task_list`/);
  assert.match(assembly.prompt, /用户明确要求后台任务、subagent、并行调研/);
  assert.match(assembly.prompt, /默认使用 `background=true`/);
  assert.match(assembly.prompt, /不要调用 `async`、`Task`、`Agent`/);
});

test("prompt snapshot freshness includes Hermes model guidance hash", async () => {
  const [{ PromptAssembler }, { promptSnapshotIsFresh }] = await Promise.all([
    import("@/agent/context/PromptAssembler"),
    import("@/agent/context/ContextEngine"),
  ]);
  const assembler = new PromptAssembler();
  const deepseekAssembly = assembler.assemble({
    availableTools: ["web_search"],
    model: "deepseek-v4-pro",
    now: new Date("2026-06-19T00:00:00.000Z"),
    platform: "webui",
  });
  const gptAssembly = assembler.assemble({
    availableTools: ["web_search"],
    model: "gpt-5",
    now: new Date("2026-06-19T00:00:00.000Z"),
    platform: "webui",
  });

  assert.equal(promptSnapshotIsFresh(deepseekAssembly, gptAssembly), false);
});
