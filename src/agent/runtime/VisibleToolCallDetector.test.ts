import assert from "node:assert/strict";
import test from "node:test";

import { VisibleToolCallDetector } from "@/agent/runtime/VisibleToolCallDetector";

const TOOL_NAMES = [
  "read_file",
  "write_file",
  "write_file_chunk",
  "web_search",
  "install_github_skill",
  "activate_skill_install",
  "Skill",
];

test("VisibleToolCallDetector detects visible function-style tool calls", () => {
  const detector = new VisibleToolCallDetector(TOOL_NAMES);

  assert.deepEqual(detector.push('web_search({"query":"test"})'), {
    reason: "visible_tool_call",
    toolName: "web_search",
  });
});

test("VisibleToolCallDetector detects XML-style active tool tags", () => {
  const detector = new VisibleToolCallDetector(TOOL_NAMES);

  assert.deepEqual(detector.push('<write_file_chunk>{"path":"index.html"}</write_file_chunk>'), {
    reason: "visible_tool_call",
    toolName: "write_file_chunk",
  });
});

test("VisibleToolCallDetector detects generic tool_type JSON wrappers", () => {
  const detector = new VisibleToolCallDetector(TOOL_NAMES);

  assert.deepEqual(
    detector.push('<tool>{"tool_type":"install_github_skill","tool_input":{"url":"https://github.com/a/b"}}</tool>'),
    {
      reason: "visible_tool_call",
      toolName: "install_github_skill",
    },
  );
});

test("VisibleToolCallDetector waits for tool identity inside generic wrappers", () => {
  const detector = new VisibleToolCallDetector(TOOL_NAMES);

  assert.equal(detector.push('<tool>{"tool_'), null);
  assert.deepEqual(detector.push('type":"web_search","tool_input":{"query":"test"}}'), {
    reason: "visible_tool_call",
    toolName: "web_search",
  });
});

test("VisibleToolCallDetector detects DeepSeek DSML invoke syntax across chunks", () => {
  const detector = new VisibleToolCallDetector(TOOL_NAMES);

  assert.equal(detector.push("<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name=\"write_"), null);
  assert.deepEqual(detector.push("file_chunk\">\n<｜｜DSML｜｜parameter name=\"content\""), {
    reason: "visible_tool_call",
    toolName: "write_file_chunk",
  });
});

test("VisibleToolCallDetector ignores ordinary tool-name text", () => {
  const detector = new VisibleToolCallDetector(TOOL_NAMES);

  assert.equal(detector.push("根因是系统提示词没有约束 web_search 的触发。"), null);
  assert.equal(detector.push("请调用 write_file_chunk 继续写入。"), null);
});

test("VisibleToolCallDetector ignores longer names and ordinary HTML", () => {
  const detector = new VisibleToolCallDetector(TOOL_NAMES);

  assert.equal(detector.push("write_file_chunk_extra({})"), null);
  assert.equal(detector.push("<section>普通 HTML 片段</section>"), null);
});
