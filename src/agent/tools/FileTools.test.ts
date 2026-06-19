import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

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
