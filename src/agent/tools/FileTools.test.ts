import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import type { PromptAssembly } from "@/agent/context/PromptAssembler";
import type { ModelStreamInput } from "@/agent/models/ProviderAdapter";
import type {
  AgentArtifact,
  AgentMessage,
  ModelToolCall,
  RunStatus,
} from "@/agent/runtime/types";

process.env.DEEPSEEK_API_KEY ??= "test-deepseek-key";
const storageRoot = mkdtempSync(join(tmpdir(), "my-agent-file-tools-"));
process.env.FILE_WORKSPACE_DIR = join(storageRoot, "workspaces");
process.env.ARTIFACT_STORAGE_DIR = join(storageRoot, "artifacts");

after(async () => {
  await rm(storageRoot, { force: true, recursive: true });
});

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    arguments: JSON.stringify(args),
    id: `call_${name}`,
    name,
  };
}

function makePrompt(prompt: string): PromptAssembly {
  return {
    prompt,
    sections: [],
    tiers: {
      context: "<project_context_layer status=\"empty\">\n</project_context_layer>",
      stable: "<stable_context status=\"empty\">\n</stable_context>",
      volatile: "<volatile_context status=\"empty\">\n</volatile_context>",
    },
  };
}

async function fileToolHarness(testName: string) {
  const [{ FileReadState }, { createFileTools }, { ToolRegistry }] = await Promise.all([
    import("@/agent/tools/FileReadState"),
    import("@/agent/tools/FileTools"),
    import("@/agent/tools/ToolRegistry"),
  ]);
  const userId = `usr_${testName}`;
  const sessionId = `sess_${testName}`;
  const registry = new ToolRegistry(createFileTools());
  const context = {
    readFileState: new FileReadState(),
    runId: `run_${testName}`,
    sessionId,
    sessions: {} as never,
    userId,
  };
  const workspacePath = (relativePath: string) =>
    join(process.env.FILE_WORKSPACE_DIR ?? "", "dev", userId, sessionId, relativePath);
  const execute = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(await registry.execute(toolCall(name, args), context)) as Record<string, unknown>;

  return { context, execute, userId, workspacePath };
}

class PptChunkModelRouter {
  async *stream(input: ModelStreamInput) {
    const lastTool = [...input.context.messages].reverse().find((message) => message.role === "tool");
    let lastToolJson: Record<string, unknown> | null = null;
    if (lastTool?.role === "tool") {
      lastToolJson = JSON.parse(lastTool.content) as Record<string, unknown>;
    }

    if (!lastToolJson) {
      yield {
        type: "tool_calls" as const,
        toolCalls: [
          {
            arguments: JSON.stringify({
              content:
                "<!doctype html><html><head><meta charset=\"utf-8\"><title>电子杂志风 HTML PPT</title></head><body><main class=\"magazine\"><section><h1>电子杂志风发布会</h1>",
              path: "index.html",
              sequence: 1,
            }),
            id: "call_chunk_1",
            name: "write_file_chunk",
          },
        ],
      };
      return;
    }

    if (lastToolJson.nextSequence === 2) {
      yield {
        type: "tool_calls" as const,
        toolCalls: [
          {
            arguments: JSON.stringify({
              content:
                "<p>时间：20:00</p><p>地点：上海</p><ol><li>趋势开场</li><li>产品亮点</li><li>下载提示</li></ol></section></main></body></html>",
              final: true,
              path: "index.html",
              sequence: 2,
            }),
            id: "call_chunk_2",
            name: "write_file_chunk",
          },
        ],
      };
      return;
    }

    yield {
      type: "text_delta" as const,
      text: "<final_answer>已生成电子杂志风 HTML PPT，可直接下载 index.html。</final_answer>",
    };
  }
}

class AgentFlowSessionRepository {
  readonly approvals: Array<{ id: string; toolCallId: string; toolName: string }> = [];
  readonly messages: AgentMessage[];
  readonly statuses: RunStatus[] = [];

  constructor(messages: AgentMessage[]) {
    this.messages = [...messages];
  }

  async getPromptSnapshot(): Promise<PromptAssembly | null> {
    return makePrompt("static prompt");
  }

  async savePromptSnapshotIfAbsent(): Promise<PromptAssembly> {
    return makePrompt("static prompt");
  }

  async listMessages(): Promise<AgentMessage[]> {
    return this.messages;
  }

  async updateRunStatus(_runId: string, status: RunStatus): Promise<void> {
    this.statuses.push(status);
  }

  async updateMessageContent(input: { content: string; messageId: string }): Promise<void> {
    const message = this.messages.find((item) => item.id === input.messageId);
    if (message) {
      message.content = input.content;
    }
  }

  async getRunStatus(): Promise<RunStatus | null> {
    return null;
  }

  async appendMessage(input: {
    artifacts?: AgentArtifact[];
    content: string;
    role: AgentMessage["role"];
    toolCallId?: string;
    toolCalls?: ModelToolCall[];
    toolName?: string;
  }): Promise<{ id: string }> {
    const message: AgentMessage = {
      id: `msg_${this.messages.length + 1}`,
      artifacts: input.artifacts,
      content: input.content,
      createdAt: new Date(this.messages.length * 1000).toISOString(),
      role: input.role,
      toolCallId: input.toolCallId,
      toolCalls: input.toolCalls,
      toolName: input.toolName,
    };
    this.messages.push(message);
    return { id: message.id };
  }

  async createToolApproval(input: { toolCallId: string; toolName: string }) {
    const approval = {
      createdAt: new Date(0).toISOString(),
      decision: null,
      id: `approval_${this.approvals.length + 1}`,
      reason: "approved in test",
      request: {},
      resolvedAt: null,
      risk: "write" as const,
      runId: "run_ppt_chunk_flow",
      sessionId: "sess_ppt_chunk_flow",
      status: "pending" as const,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      userId: "usr_ppt_chunk_flow",
    };
    this.approvals.push(approval);
    return approval;
  }

  async waitForToolApproval(input: { approvalId: string }) {
    const approval = this.approvals.find((item) => item.id === input.approvalId);
    if (!approval) {
      throw new Error("approval not found");
    }
    return {
      ...approval,
      createdAt: new Date(0).toISOString(),
      decision: { decision: "approved" },
      resolvedAt: new Date(1).toISOString(),
      status: "approved" as const,
    };
  }
}

test("write_file creates a workspace file and downloadable artifact", async () => {
  const { execute, userId, workspacePath } = await fileToolHarness("create");
  const result = await execute("write_file", {
    content: "<!doctype html><title>Artifact</title>",
    path: "index.html",
  });

  assert.equal(result.success, true);
  assert.equal(result.operation, "create");
  assert.equal(await readFile(workspacePath("index.html"), "utf8"), "<!doctype html><title>Artifact</title>");

  const { getArtifactForDownload } = await import("@/agent/tools/FileWorkspace");
  const artifact = result.artifact as { id: string };
  const download = await getArtifactForDownload({ artifactId: artifact.id, userId });

  assert.ok(download);
  assert.equal(download.metadata.filename, "index.html");
  assert.equal(download.metadata.contentType, "text/html; charset=utf-8");
  assert.equal(download.content.toString("utf8"), "<!doctype html><title>Artifact</title>");
});

test("write_file_chunk creates a downloadable artifact from ordered chunks", async () => {
  const { execute, userId, workspacePath } = await fileToolHarness("chunk-create");
  const chunkOne = "<!doctype html><html><head><title>电子杂志风</title></head><body>";
  const chunkTwo = "<section><h1>Q3 Roadshow</h1><p>时间、地点、三条议程。</p></section></body></html>";
  const content = `${chunkOne}${chunkTwo}`;
  const { fileSha256, getArtifactForDownload } = await import("@/agent/tools/FileWorkspace");

  const first = await execute("write_file_chunk", {
    content: chunkOne,
    path: "deck.html",
    sequence: 1,
  });

  assert.equal(first.success, true);
  assert.equal(first.final, false);
  assert.equal(first.nextSequence, 2);
  assert.equal(first.artifact, undefined);

  const second = await execute("write_file_chunk", {
    content: chunkTwo,
    expected_sha256: fileSha256(content),
    final: true,
    path: "deck.html",
    sequence: 2,
  });

  assert.equal(second.success, true);
  assert.equal(second.final, true);
  assert.equal(second.sizeBytes, Buffer.byteLength(content));
  assert.equal(await readFile(workspacePath("deck.html"), "utf8"), content);

  const artifact = second.artifact as { id: string };
  const download = await getArtifactForDownload({ artifactId: artifact.id, userId });
  assert.ok(download);
  assert.equal(download.metadata.filename, "deck.html");
  assert.equal(download.metadata.contentType, "text/html; charset=utf-8");
  assert.equal(download.content.toString("utf8"), content);
});

test("agent flow uses chunked file writes for the PPT download prompt", async () => {
  const [{ AgentLoop }, { ContextEngine }, { ToolRegistry }, { createFileTools }] =
    await Promise.all([
      import("@/agent/runtime/AgentLoop"),
      import("@/agent/context/ContextEngine"),
      import("@/agent/tools/ToolRegistry"),
      import("@/agent/tools/FileTools"),
    ]);
  const sessions = new AgentFlowSessionRepository([
    {
      id: "user_1",
      content: "用ppt skill生成一个html ppt，要求非常精美的电子杂志风格的。然后让我下载",
      createdAt: new Date(0).toISOString(),
      role: "user",
    },
  ]);
  const loop = new AgentLoop(
    new ContextEngine({ assemble: () => makePrompt("static prompt") } as never),
    new PptChunkModelRouter() as never,
    sessions as never,
    { maybeRun: async () => undefined } as never,
    undefined,
    undefined,
    () => new ToolRegistry(createFileTools()),
  );

  const events = [];
  for await (const event of loop.execute({
    maxTokens: 1024,
    model: "deepseek-v4-flash",
    permissionMode: "ask-on-write",
    runId: "run_ppt_chunk_flow",
    sessionId: "sess_ppt_chunk_flow",
    signal: new AbortController().signal,
    thinking: "disabled",
    userId: "usr_ppt_chunk_flow",
    userMessageId: "user_1",
  })) {
    events.push(event);
  }

  const artifactEvent = events.find((event) => event.type === "artifact.created");
  assert.equal(sessions.approvals.length, 1);
  assert.equal(sessions.approvals[0]?.toolCallId, "call_chunk_1");
  assert.equal(events.filter((event) => event.type === "tool.completed").length, 2);
  assert.ok(artifactEvent && artifactEvent.type === "artifact.created");

  const { getArtifactForDownload } = await import("@/agent/tools/FileWorkspace");
  const download = await getArtifactForDownload({
    artifactId: artifactEvent.artifact.id,
    userId: "usr_ppt_chunk_flow",
  });
  assert.ok(download);
  assert.equal(download.metadata.filename, "index.html");
  assert.match(download.content.toString("utf8"), /电子杂志风发布会/);
  assert.match(sessions.messages.at(-1)?.content ?? "", /index\.html/);
});

test("write_file_chunk enforces chunk order and active run ownership", async () => {
  const { execute } = await fileToolHarness("chunk-order");

  const missingState = await execute("write_file_chunk", {
    content: "second",
    path: "ordered.txt",
    sequence: 2,
  });
  assert.equal(missingState.success, false);
  assert.match(String(missingState.error), /sequence=1|active chunked write/i);

  const first = await execute("write_file_chunk", {
    content: "first",
    path: "ordered.txt",
    sequence: 1,
  });
  assert.equal(first.success, true);

  const outOfOrder = await execute("write_file_chunk", {
    content: "third",
    path: "ordered.txt",
    sequence: 3,
  });
  assert.equal(outOfOrder.success, false);
  assert.match(String(outOfOrder.error), /Expected sequence=2/);
});

test("write_file_chunk clears active state after a final checksum mismatch", async () => {
  const { execute } = await fileToolHarness("chunk-checksum-mismatch");

  const first = await execute("write_file_chunk", {
    content: "first",
    path: "checksum.txt",
    sequence: 1,
  });
  assert.equal(first.success, true);

  const mismatch = await execute("write_file_chunk", {
    content: "second",
    expected_sha256: "not-the-real-sha",
    final: true,
    path: "checksum.txt",
    sequence: 2,
  });
  assert.equal(mismatch.success, false);
  assert.match(String(mismatch.error), /checksum/);

  const retryAppend = await execute("write_file_chunk", {
    content: "second",
    final: true,
    path: "checksum.txt",
    sequence: 2,
  });
  assert.equal(retryAppend.success, false);
  assert.match(String(retryAppend.error), /sequence=1|active chunked write/i);
});

test("write_file_chunk refuses to overwrite existing files until they are fully read", async () => {
  const { execute, workspacePath } = await fileToolHarness("chunk-overwrite");
  const absolutePath = workspacePath("existing.html");
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "old", "utf8");

  const rejected = await execute("write_file_chunk", {
    content: "new",
    final: true,
    path: "existing.html",
    sequence: 1,
  });

  assert.equal(rejected.success, false);
  assert.match(String(rejected.error), /read_file/);

  const read = await execute("read_file", { path: "existing.html" });
  assert.equal(read.success, true);

  const accepted = await execute("write_file_chunk", {
    content: "new",
    final: true,
    path: "existing.html",
    sequence: 1,
  });

  assert.equal(accepted.success, true);
  assert.equal(await readFile(absolutePath, "utf8"), "new");
});

test("write_file directs oversized single writes to chunked writing", async () => {
  const { execute } = await fileToolHarness("large-direct-write");
  const result = await execute("write_file", {
    content: "x".repeat(129 * 1024),
    path: "large.txt",
  });

  assert.equal(result.success, false);
  assert.match(String(result.error), /write_file_chunk/);
});

test("write_file refuses to overwrite existing files until they are fully read", async () => {
  const { execute, workspacePath } = await fileToolHarness("overwrite");
  const absolutePath = workspacePath("notes.txt");
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "old", "utf8");

  const rejected = await execute("write_file", {
    content: "new",
    path: "notes.txt",
  });

  assert.equal(rejected.success, false);
  assert.match(String(rejected.error), /read_file/);

  const read = await execute("read_file", { path: "notes.txt" });
  assert.equal(read.success, true);

  const accepted = await execute("write_file", {
    content: "new",
    path: "notes.txt",
  });

  assert.equal(accepted.success, true);
  assert.equal(accepted.operation, "update");
  assert.equal(await readFile(absolutePath, "utf8"), "new");
});

test("partial reads do not authorize file writes", async () => {
  const { execute, workspacePath } = await fileToolHarness("partial");
  const absolutePath = workspacePath("long.txt");
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "line 1\nline 2\nline 3", "utf8");

  const read = await execute("read_file", {
    limit: 1,
    path: "long.txt",
  });
  assert.equal(read.success, true);
  assert.equal(read.isPartialView, true);

  const rejected = await execute("write_file", {
    content: "replacement",
    path: "long.txt",
  });
  assert.equal(rejected.success, false);
  assert.match(String(rejected.error), /fully read/);
});

test("edit_file performs exact replacements only after a full read", async () => {
  const { execute, workspacePath } = await fileToolHarness("edit");
  const absolutePath = workspacePath("page.html");
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "<h1>Draft</h1>", "utf8");

  const rejected = await execute("edit_file", {
    new_string: "Final",
    old_string: "Draft",
    path: "page.html",
  });
  assert.equal(rejected.success, false);
  assert.match(String(rejected.error), /read_file/);

  const read = await execute("read_file", { path: "page.html" });
  assert.equal(read.success, true);

  const accepted = await execute("edit_file", {
    new_string: "Final",
    old_string: "Draft",
    path: "page.html",
  });

  assert.equal(accepted.success, true);
  assert.equal(accepted.matches, 1);
  assert.equal(await readFile(absolutePath, "utf8"), "<h1>Final</h1>");
});

test("file tools reject unsafe workspace paths before execution", async () => {
  const { execute } = await fileToolHarness("unsafe");
  const result = await execute("write_file", {
    content: "secret",
    path: "../outside.txt",
  });

  assert.equal(result.success, false);
  assert.match(String(result.error), /unsafe|escapes|segment/i);
});
