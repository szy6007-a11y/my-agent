import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

test("PromptAssembler includes the production output protocol contract", async () => {
  const { PromptAssembler } = await import("@/agent/context/PromptAssembler");
  const assembly = new PromptAssembler().assemble({
    availableTools: ["write_file_chunk", "web_search"],
    now: new Date("2026-06-19T00:00:00.000Z"),
    platform: "webui",
  });

  assert.equal(assembly.metadata?.promptVersion, "2026-06-19.output-protocol-v1");
  assert.match(assembly.prompt, /<output_protocol_guidance/);
  assert.match(assembly.prompt, /工具只能通过系统原生 tool call 通道调用/);
  assert.match(assembly.prompt, /禁止把工具调用写成 XML、HTML、Markdown、JSON、函数调用文本、DSML/);
  assert.match(assembly.prompt, /如果 `SKILL\.md` 明确要求调用某个工具/);
  assert.match(assembly.prompt, /不要用普通正文回答、承诺、追问、列计划或复述工具名来替代/);
});
