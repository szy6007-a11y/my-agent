import { mkdir, stat, writeFile } from "fs/promises";
import { dirname } from "path";

import type { AgentTool, ToolExecutionContext, ToolValidationResult } from "@/agent/tools/types";
import { toolError, toolSuccess } from "@/agent/tools/types";
import {
  fileSha256,
  publishWorkspaceArtifact,
  readWorkspaceFile,
  readWorkspaceFileForWrite,
  resolveWorkspaceFile,
} from "@/agent/tools/FileWorkspace";

type ReadFileArgs = {
  limit?: unknown;
  offset?: unknown;
  path?: unknown;
};

type WriteFileArgs = {
  content?: unknown;
  path?: unknown;
};

type EditFileArgs = {
  new_string?: unknown;
  old_string?: unknown;
  path?: unknown;
  replace_all?: unknown;
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

function boolArg(value: unknown): boolean {
  return value === true || value === "true";
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
          "Create or overwrite a text file in the current session workspace. Existing files must be read with read_file first. Returns a downloadable artifact for the written file.",
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
      if (Buffer.byteLength(input.content) > 2 * 1024 * 1024) {
        return { ok: false, message: "content is too large; keep file writes under 2 MiB." };
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
          "Perform an exact string replacement in a text file in the current session workspace. The file must be fully read with read_file first. Returns a downloadable artifact for the edited file.",
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

  return [readFileTool, writeFileTool, editFileTool];
}
