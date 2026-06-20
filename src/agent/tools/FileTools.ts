import { appendFile, mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";

import type { AgentTool, ToolExecutionContext, ToolValidationResult } from "@/agent/tools/types";
import { toolError, toolSuccess } from "@/agent/tools/types";
import {
  fileSha256,
  publishWorkspaceArtifact,
  readWorkspaceFile,
  readWorkspaceFileForWrite,
  resolveWorkspaceFile,
  workspaceStateRoot,
} from "@/agent/tools/FileWorkspace";

const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_DIRECT_WRITE_BYTES = 128 * 1024;

type ReadFileArgs = {
  limit?: unknown;
  offset?: unknown;
  path?: unknown;
};

type WriteFileArgs = {
  content?: unknown;
  path?: unknown;
};

type WriteFileChunkArgs = {
  content?: unknown;
  expected_sha256?: unknown;
  final?: unknown;
  path?: unknown;
  sequence?: unknown;
};

type EditFileArgs = {
  new_string?: unknown;
  old_string?: unknown;
  path?: unknown;
  replace_all?: unknown;
};

type ChunkWriteState = {
  nextSequence: number;
  path: string;
  runId: string;
  sizeBytes: number;
  startedAt: string;
  updatedAt: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {};
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("offset and limit must be positive integers.");
  }
  return number;
}

function positiveIntArg(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function boolArg(value: unknown): boolean {
  return value === true || value === "true";
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isNoEntryError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function validatePath(path: string, context: ToolExecutionContext): ToolValidationResult {
  if (!path.trim()) {
    return { ok: false, message: "path is required." };
  }
  try {
    resolveWorkspaceFile({
      path,
      sessionId: context.sessionId,
      userId: context.userId,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid workspace file path.",
    };
  }
  return { ok: true };
}

function readStateFresh(
  context: ToolExecutionContext,
  absolutePath: string,
  current: { content: string; exists: boolean; mtimeMs: number | null },
) {
  if (!current.exists) {
    return { ok: true as const };
  }
  const lastRead = context.readFileState?.get(absolutePath);
  if (!lastRead || lastRead.isPartialView) {
    return {
      message: "File has not been fully read yet. Call read_file before writing to an existing file.",
      ok: false as const,
    };
  }
  if (current.mtimeMs !== null && current.mtimeMs > lastRead.timestampMs) {
    if (current.content !== lastRead.content) {
      return {
        message:
          "File has been modified since it was read. Read it again before attempting to write.",
        ok: false as const,
      };
    }
  }
  return { ok: true as const };
}

async function artifactPayload(input: {
  absolutePath: string;
  context: ToolExecutionContext;
  relativePath: string;
}) {
  return publishWorkspaceArtifact({
    absolutePath: input.absolutePath,
    relativePath: input.relativePath,
    runId: input.context.runId,
    sessionId: input.context.sessionId,
    userId: input.context.userId,
  });
}

function chunkStatePath(context: ToolExecutionContext, relativePath: string): string {
  return join(
    workspaceStateRoot(context.userId, context.sessionId),
    "chunk-writes",
    `${fileSha256(relativePath)}.json`,
  );
}

async function readChunkState(
  context: ToolExecutionContext,
  relativePath: string,
): Promise<ChunkWriteState | null> {
  try {
    const raw = await readFile(chunkStatePath(context, relativePath), "utf8");
    const parsed = JSON.parse(raw) as Partial<ChunkWriteState>;
    if (
      typeof parsed.path !== "string" ||
      typeof parsed.runId !== "string" ||
      typeof parsed.nextSequence !== "number" ||
      typeof parsed.sizeBytes !== "number"
    ) {
      return null;
    }
    return parsed as ChunkWriteState;
  } catch (error) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
}

async function writeChunkState(
  context: ToolExecutionContext,
  relativePath: string,
  state: ChunkWriteState,
) {
  const statePath = chunkStatePath(context, relativePath);
  await mkdir(dirname(statePath), { mode: 0o700, recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function removeChunkState(context: ToolExecutionContext, relativePath: string) {
  await rm(chunkStatePath(context, relativePath), { force: true });
}

export function createFileTools(): AgentTool[] {
  const readFileTool: AgentTool = {
    definition: {
      function: {
        description:
          "Read a text file from the current session workspace. Use this before editing or overwriting an existing file.",
        name: "read_file",
        parameters: {
          additionalProperties: false,
          properties: {
            limit: {
              description: "Optional number of lines to read.",
              type: "number",
            },
            offset: {
              description: "Optional 1-based starting line number.",
              type: "number",
            },
            path: {
              description:
                "File path relative to the session workspace, for example index.html or src/app.ts.",
              type: "string",
            },
          },
          required: ["path"],
          type: "object",
        },
      },
      type: "function",
    },
    isReadOnly: true,
    maxResultSizeChars: 80_000,
    name: "read_file",
    risk: "read",
    validateInput(args, context) {
      return validatePath(stringArg((asRecord(args) as ReadFileArgs).path), context);
    },
    async execute(args, context) {
      const input = asRecord(args) as ReadFileArgs;
      const path = stringArg(input.path);
      const file = await readWorkspaceFile({
        limit: optionalPositiveInt(input.limit),
        offset: optionalPositiveInt(input.offset),
        path,
        sessionId: context.sessionId,
        userId: context.userId,
      });
      context.readFileState?.set(file.absolutePath, {
        content: file.content,
        isPartialView: file.isPartialView,
        limit: optionalPositiveInt(input.limit),
        offset: optionalPositiveInt(input.offset) ?? 1,
        timestampMs: file.mtimeMs ?? 0,
      });
      return toolSuccess({
        content: file.content,
        isPartialView: file.isPartialView,
        path: file.relativePath,
        totalLines: file.totalLines,
      });
    },
  };

  async function finishChunkedWrite(input: {
    context: ToolExecutionContext;
    expectedSha256?: string;
    relativePath: string;
    sequence: number;
  }) {
    const written = await readWorkspaceFileForWrite({
      path: input.relativePath,
      sessionId: input.context.sessionId,
      userId: input.context.userId,
    });
    const contentSha256 = fileSha256(written.content);
    if (input.expectedSha256 && input.expectedSha256 !== contentSha256) {
      await removeChunkState(input.context, written.relativePath);
      return toolError("Final chunked file checksum did not match expected_sha256.", {
        actualSha256: contentSha256,
        expectedSha256: input.expectedSha256,
        path: written.relativePath,
        recovery: "Re-read the target file, verify its content, and restart with sequence=1.",
      });
    }

    input.context.readFileState?.set(written.absolutePath, {
      content: written.content,
      timestampMs: written.mtimeMs ?? Date.now(),
    });
    await removeChunkState(input.context, written.relativePath);
    const artifact = await artifactPayload({
      absolutePath: written.absolutePath,
      context: input.context,
      relativePath: written.relativePath,
    });

    return toolSuccess({
      artifact,
      contentSha256,
      final: true,
      operation: "chunked_write",
      path: written.relativePath,
      sequence: input.sequence,
      sizeBytes: Buffer.byteLength(written.content),
    });
  }

  const writeFileChunkTool: AgentTool = {
    buildApproval: async (args, context) => {
      const input = asRecord(args) as WriteFileChunkArgs;
      const path = stringArg(input.path);
      const content = stringArg(input.content);
      const sequence = positiveIntArg(input.sequence, "sequence");
      const resolved = resolveWorkspaceFile({
        path,
        sessionId: context.sessionId,
        userId: context.userId,
      });
      let operation = "create";
      try {
        const fileStat = await stat(resolved.absolutePath);
        operation = fileStat.isFile() ? "overwrite" : "write";
      } catch {
        operation = "create";
      }

      return {
        reason:
          operation === "create" ?
            `开始分段创建工作区文件：${resolved.relativePath}`
          : `开始分段覆盖工作区文件：${resolved.relativePath}`,
        request: {
          chunkBytes: Buffer.byteLength(content),
          chunkSha256: fileSha256(content),
          final: boolArg(input.final),
          operation,
          path: resolved.relativePath,
          sequence,
          subsequentChunks:
            "Approved sequence=1 starts this chunked write; later ordered chunks for the same path in this run continue without repeated approval.",
        },
      };
    },
    definition: {
      function: {
        description:
          "Incrementally create or overwrite a large text file in the current session workspace without sending the entire file in one tool call. Use only when the user explicitly asks to create, save, export, download, or overwrite a file/artifact; do not use for ordinary Q&A, search, explanation, summaries, dates, stocks, or event queries. Use this for generated HTML/PPT/report artifacts or any file likely over 40 KB. Send chunks in order with sequence starting at 1; each chunk must be at most 64 KiB. Prefer chunks close to that limit, while staying valid, so long files finish within the agent iteration budget. Use sequence=1 to create/truncate the file, then sequence=2,3,... to append. Set final=true only on the last chunk to publish the downloadable artifact. Existing files must be read with read_file before sequence=1.",
        name: "write_file_chunk",
        parameters: {
          additionalProperties: false,
          properties: {
            content: {
              description:
                "Next text chunk to write. Keep each chunk under 64 KiB and prefer sizable chunks for large files.",
              type: "string",
            },
            expected_sha256: {
              description:
                "Optional SHA-256 hex digest of the complete final file. Only checked when final=true.",
              type: "string",
            },
            final: {
              description:
                "Set true on the last chunk. The tool publishes a downloadable artifact only for the final chunk.",
              type: "boolean",
            },
            path: {
              description: "File path relative to the session workspace, such as index.html.",
              type: "string",
            },
            sequence: {
              description: "Positive chunk sequence number. The first chunk must be sequence=1.",
              type: "number",
            },
          },
          required: ["path", "content", "sequence"],
          type: "object",
        },
      },
      type: "function",
    },
    isReadOnly: false,
    maxResultSizeChars: 12_000,
    name: "write_file_chunk",
    requiresApproval: async (args, context) => {
      const input = asRecord(args) as WriteFileChunkArgs;
      const sequence = positiveIntArg(input.sequence, "sequence");
      if (sequence === 1) {
        return true;
      }
      const pathCheck = resolveWorkspaceFile({
        path: stringArg(input.path),
        sessionId: context.sessionId,
        userId: context.userId,
      });
      const state = await readChunkState(context, pathCheck.relativePath);
      return !(state && state.runId === context.runId && state.nextSequence === sequence);
    },
    risk: "write",
    async validateInput(args, context) {
      const input = asRecord(args) as WriteFileChunkArgs;
      const pathCheck = validatePath(stringArg(input.path), context);
      if (!pathCheck.ok) return pathCheck;
      if (typeof input.content !== "string") {
        return { ok: false, message: "content is required." };
      }
      const chunkBytes = Buffer.byteLength(input.content);
      if (chunkBytes > MAX_CHUNK_BYTES) {
        return {
          ok: false,
          message: `content chunk is too large (${chunkBytes} bytes; limit is ${MAX_CHUNK_BYTES}). Split it into smaller write_file_chunk calls.`,
        };
      }

      let sequence: number;
      try {
        sequence = positiveIntArg(input.sequence, "sequence");
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : "sequence is invalid.",
        };
      }
      const resolved = resolveWorkspaceFile({
        path: stringArg(input.path),
        sessionId: context.sessionId,
        userId: context.userId,
      });
      const state = await readChunkState(context, resolved.relativePath);
      if (sequence === 1) {
        if (state && state.runId === context.runId) {
          return {
            ok: false,
            message:
              "A chunked write for this path is already active in this run. Continue with the reported nextSequence instead of starting at sequence=1.",
          };
        }
      } else {
        if (!state) {
          return {
            ok: false,
            message:
              "No active chunked write exists for this path. Start with write_file_chunk sequence=1.",
          };
        }
        if (state.runId !== context.runId) {
          return {
            ok: false,
            message:
              "The active chunked write belongs to a different run. Restart with sequence=1 after confirming the target state.",
          };
        }
        if (state.nextSequence !== sequence) {
          return {
            ok: false,
            message: `Chunk sequence out of order. Expected sequence=${state.nextSequence}.`,
            extra: { nextSequence: state.nextSequence },
          };
        }
      }
      return { ok: true };
    },
    async execute(args, context) {
      const input = asRecord(args) as WriteFileChunkArgs;
      const path = stringArg(input.path);
      const content = stringArg(input.content);
      const final = boolArg(input.final);
      const sequence = positiveIntArg(input.sequence, "sequence");
      const expectedSha256 = optionalStringArg(input.expected_sha256);
      const current = await readWorkspaceFileForWrite({
        path,
        sessionId: context.sessionId,
        userId: context.userId,
      });

      if (sequence === 1) {
        const fresh = readStateFresh(context, current.absolutePath, current);
        if (!fresh.ok) {
          return toolError(fresh.message);
        }
        await mkdir(dirname(current.absolutePath), { mode: 0o700, recursive: true });
        await writeFile(current.absolutePath, content, "utf8");
      } else {
        const state = await readChunkState(context, current.relativePath);
        if (!state || state.runId !== context.runId || state.nextSequence !== sequence) {
          return toolError("Chunked write state is missing or out of order. Re-read the target and restart.");
        }
        if (!current.exists) {
          return toolError("Chunked write target is missing. Re-read the target and restart with sequence=1.");
        }
        await appendFile(current.absolutePath, content, "utf8");
      }

      const fileStat = await stat(current.absolutePath);
      if (final) {
        return finishChunkedWrite({
          context,
          expectedSha256,
          relativePath: current.relativePath,
          sequence,
        });
      }

      const now = new Date().toISOString();
      const previous = sequence === 1 ? null : await readChunkState(context, current.relativePath);
      await writeChunkState(context, current.relativePath, {
        nextSequence: sequence + 1,
        path: current.relativePath,
        runId: context.runId,
        sizeBytes: fileStat.size,
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
      });

      return toolSuccess({
        chunkBytes: Buffer.byteLength(content),
        final: false,
        nextSequence: sequence + 1,
        operation: sequence === 1 ? "chunked_write_started" : "chunked_write_appended",
        path: current.relativePath,
        sequence,
        sizeBytes: fileStat.size,
      });
    },
  };

  const writeFileTool: AgentTool = {
    buildApproval: async (args, context) => {
      const input = asRecord(args) as WriteFileArgs;
      const path = stringArg(input.path);
      const content = stringArg(input.content);
      const resolved = resolveWorkspaceFile({
        path,
        sessionId: context.sessionId,
        userId: context.userId,
      });
      let operation = "create";
      try {
        const fileStat = await stat(resolved.absolutePath);
        operation = fileStat.isFile() ? "update" : "write";
      } catch {
        operation = "create";
      }
      return {
        reason:
          operation === "create" ?
            `创建工作区文件：${resolved.relativePath}`
          : `覆盖工作区文件：${resolved.relativePath}`,
        request: {
          contentSha256: fileSha256(content),
          operation,
          path: resolved.relativePath,
          sizeBytes: Buffer.byteLength(content),
        },
      };
    },
    definition: {
      function: {
        description:
          "Create or overwrite a small text file in the current session workspace. Use only when the user explicitly asks to create, save, export, download, or overwrite a file/artifact; do not use for ordinary Q&A, search, explanation, summaries, dates, stocks, or event queries. Existing files must be read with read_file first. Returns a downloadable artifact for the written file. For generated HTML/PPT/report artifacts or content likely over 40 KB, use write_file_chunk instead so the model does not send the whole file in one tool call.",
        name: "write_file",
        parameters: {
          additionalProperties: false,
          properties: {
            content: {
              description: "Complete file content to write.",
              type: "string",
            },
            path: {
              description: "File path relative to the session workspace, such as index.html.",
              type: "string",
            },
          },
          required: ["path", "content"],
          type: "object",
        },
      },
      type: "function",
    },
    isReadOnly: false,
    maxResultSizeChars: 12_000,
    name: "write_file",
    requiresApproval: true,
    risk: "write",
    validateInput(args, context) {
      const input = asRecord(args) as WriteFileArgs;
      const pathCheck = validatePath(stringArg(input.path), context);
      if (!pathCheck.ok) return pathCheck;
      if (typeof input.content !== "string") {
        return { ok: false, message: "content is required." };
      }
      if (Buffer.byteLength(input.content) > MAX_DIRECT_WRITE_BYTES) {
        return {
          ok: false,
          message:
            "content is too large for write_file; use write_file_chunk with ordered chunks and final=true on the last chunk.",
        };
      }
      return { ok: true };
    },
    async execute(args, context) {
      const input = asRecord(args) as WriteFileArgs;
      const path = stringArg(input.path);
      const content = stringArg(input.content);
      const current = await readWorkspaceFileForWrite({
        path,
        sessionId: context.sessionId,
        userId: context.userId,
      });
      const fresh = readStateFresh(context, current.absolutePath, current);
      if (!fresh.ok) {
        return toolError(fresh.message);
      }

      await mkdir(dirname(current.absolutePath), { mode: 0o700, recursive: true });
      await writeFile(current.absolutePath, content, "utf8");
      const written = await readWorkspaceFileForWrite({
        path,
        sessionId: context.sessionId,
        userId: context.userId,
      });
      context.readFileState?.set(written.absolutePath, {
        content,
        timestampMs: written.mtimeMs ?? Date.now(),
      });
      const artifact = await artifactPayload({
        absolutePath: written.absolutePath,
        context,
        relativePath: written.relativePath,
      });

      return toolSuccess({
        artifact,
        operation: current.exists ? "update" : "create",
        path: written.relativePath,
        sizeBytes: Buffer.byteLength(content),
      });
    },
  };

  const editFileTool: AgentTool = {
    buildApproval: async (args, context) => {
      const input = asRecord(args) as EditFileArgs;
      const path = stringArg(input.path);
      const resolved = resolveWorkspaceFile({
        path,
        sessionId: context.sessionId,
        userId: context.userId,
      });
      return {
        reason: `编辑工作区文件：${resolved.relativePath}`,
        request: {
          newStringPreview: stringArg(input.new_string).slice(0, 400),
          oldStringPreview: stringArg(input.old_string).slice(0, 400),
          path: resolved.relativePath,
          replaceAll: boolArg(input.replace_all),
        },
      };
    },
    definition: {
      function: {
        description:
          "Perform an exact string replacement in a text file in the current session workspace. Use only when the user explicitly asks to edit or update an existing file/artifact; do not use for ordinary Q&A, search, explanation, summaries, dates, stocks, or event queries. The file must be fully read with read_file first. Returns a downloadable artifact for the edited file.",
        name: "edit_file",
        parameters: {
          additionalProperties: false,
          properties: {
            new_string: { type: "string" },
            old_string: { type: "string" },
            path: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["path", "old_string", "new_string"],
          type: "object",
        },
      },
      type: "function",
    },
    isReadOnly: false,
    maxResultSizeChars: 12_000,
    name: "edit_file",
    requiresApproval: true,
    risk: "write",
    validateInput(args, context) {
      const input = asRecord(args) as EditFileArgs;
      const pathCheck = validatePath(stringArg(input.path), context);
      if (!pathCheck.ok) return pathCheck;
      if (typeof input.old_string !== "string" || typeof input.new_string !== "string") {
        return { ok: false, message: "old_string and new_string are required." };
      }
      if (input.old_string === input.new_string) {
        return { ok: false, message: "old_string and new_string must be different." };
      }
      return { ok: true };
    },
    async execute(args, context) {
      const input = asRecord(args) as EditFileArgs;
      const path = stringArg(input.path);
      const oldString = stringArg(input.old_string);
      const newString = stringArg(input.new_string);
      const replaceAll = boolArg(input.replace_all);
      const current = await readWorkspaceFileForWrite({
        path,
        sessionId: context.sessionId,
        userId: context.userId,
      });
      if (!current.exists) {
        return toolError("File does not exist. Use write_file to create new files.");
      }
      const fresh = readStateFresh(context, current.absolutePath, current);
      if (!fresh.ok) {
        return toolError(fresh.message);
      }
      const matches = current.content.split(oldString).length - 1;
      if (matches === 0) {
        return toolError(`String to replace was not found in ${current.relativePath}.`);
      }
      if (matches > 1 && !replaceAll) {
        return toolError(
          `Found ${matches} matches. Set replace_all=true or provide a more specific old_string.`,
        );
      }

      const updated =
        replaceAll ? current.content.replaceAll(oldString, newString) : (
          current.content.replace(oldString, newString)
        );
      await writeFile(current.absolutePath, updated, "utf8");
      const written = await readWorkspaceFileForWrite({
        path,
        sessionId: context.sessionId,
        userId: context.userId,
      });
      context.readFileState?.set(written.absolutePath, {
        content: updated,
        timestampMs: written.mtimeMs ?? Date.now(),
      });
      const artifact = await artifactPayload({
        absolutePath: written.absolutePath,
        context,
        relativePath: written.relativePath,
      });

      return toolSuccess({
        artifact,
        matches,
        operation: "edit",
        path: written.relativePath,
      });
    },
  };

  return [readFileTool, writeFileChunkTool, writeFileTool, editFileTool];
}
