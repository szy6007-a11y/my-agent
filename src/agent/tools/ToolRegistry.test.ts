import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";

test("default ToolRegistry exposes task and delegation tools", async () => {
  const { ToolRegistry } = await import("@/agent/tools/ToolRegistry");
  const names = new ToolRegistry().names;

  assert.ok(names.includes("task_create"));
  assert.ok(names.includes("task_update"));
  assert.ok(names.includes("task_list"));
  assert.ok(names.includes("task_output"));
  assert.ok(names.includes("task_cancel"));
  assert.ok(names.includes("delegate_task"));
});

test("subagent toolset excludes recursive, interactive, memory, and write tools", async () => {
  const { createSubagentTools } = await import("@/agent/tools/ToolRegistry");
  const names = createSubagentTools(["file", "session", "skills"]).map((tool) => tool.name);

  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("session_search"));
  assert.ok(names.includes("skills_list"));
  assert.ok(names.includes("skill_view"));
  assert.ok(!names.includes("ask_user_question"));
  assert.ok(!names.includes("delegate_task"));
  assert.ok(!names.includes("memory"));
  assert.ok(!names.includes("task_create"));
  assert.ok(!names.includes("write_file"));
  assert.ok(!names.includes("edit_file"));
  assert.ok(!names.includes("skill_manage"));
});
